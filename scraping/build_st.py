#!/usr/bin/env python3
"""Build ../st.json from Toray's live Ultrasuede® ST swatch site.

ST is still current, and swatches.ultrasuede.us still serves it — the same site
LT's 36 were reconstructed from, which now offers only ST and HP. So this reads
the live page rather than the archive.

    python3 scraping/build_st.py --fetch    # snapshot page + swatch photos
    python3 scraping/build_st.py            # sample colours, write ../st.json

Of the products here this is the one closest to LT: same manufacturer, same
style-and-colour-number scheme (8023-5597), swatch photographs shot the same
way, and enlarged views at 418px — the same size LT's own large captures are.
That last point matters: 418 clears build_dataset's NAP_MEASURABLE of 300, so
ST contrast is measured rather than modelled, and an ST shader and an LT shader
are the same kind of picture.

The page markup is NOT the one build_dataset's SWATCH_RE parses. That regex was
written for the archived captures, which wrapped a swatch in <span>…</em>; the
live site emits a structured <li> with swatchesNumber / swatchesTitle, so it
gets its own parser here rather than a regex that has to satisfy both.
"""

import argparse
import html
import json
import pathlib
import re
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

# Shared with LT rather than reimplemented, so the two products' hexes and
# shaders mean the same thing. build_dataset guards its entry point.
from build_dataset import nap

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / 'scraping' / 'st_page.html'
# The last capture of the previous style. ST was restyled 2223 -> 8023 between
# 2019-05 and 2021-09 and every colour renumbered, so this is what says which
# old number a current colour used to carry, and which colours did not survive
# the change. Committed rather than fetched: it is an archive capture and will
# not change. Wayback holds no swatch IMAGES for style 2223 at all -- only 5538,
# 5539, 5864 and 8801 (LT) -- so the dropped colours have a name and a number
# and no picture, exactly like LT's historical_colors.
SNAPSHOT_2019 = ROOT / 'scraping' / 'st_page_2019.html'
ARCHIVE_2019 = ('https://web.archive.org/web/20190512050526/'
                'http://swatches.ultrasuede.us/swatches/search_result.php?product=ST')
IMAGES = ROOT / 'images'
IMAGES_LARGE = IMAGES / 'large'
OUT = ROOT / 'st.json'

SITE = 'https://swatches.ultrasuede.us'
PAGE = f'{SITE}/swatches/search_result.php?product=ST'
LARGE_URL = f'{SITE}/swatches/images_enlarged_view/'
SMALL_EDGE = 100

# The markup the site used before the restyle.
OLD_ITEM_RE = re.compile(
    r'images/(\d{4})-(\d{4})\.jpg" alt=""></a><span>(.*?)</em><br>\s*(.*?)</span>',
    re.S)

ITEM_RE = re.compile(
    r'<li>\s*<p class="swatchesImg">.*?'
    r'<p class="swatchesType">(.*?)</p>\s*'
    r'<p class="swatchesNumber">(.*?)</p>\s*'
    r'<p class="swatchesTitle">(.*?)</p>(.*?)</li>',
    re.S)

UA = 'ultrasuede-color-library/1.0 (+https://github.com/gwbischof/ultrasuede-color-library)'


def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = r.read()
    return d if binary else d.decode('utf-8', 'replace')


def parse_page(text):
    """[(sku, style, code, name, orderable)] from the live swatch list."""
    out = []
    for kind, sku, name, rest in ITEM_RE.findall(text):
        sku = sku.strip()
        if '-' not in sku:
            continue
        style, code = sku.split('-', 1)
        out.append({
            'sku': sku,
            'style': style,
            'code': code,
            'name': html.unescape(re.sub('<[^>]+>', '', name)).strip(),
            'kind': kind.strip(),
            # the Request button is a sample_request link; no link, not orderable
            'orderable': 'addsku' in rest,
        })
    if not out:
        sys.exit('no swatches parsed — the page markup may have changed')
    return out


def parse_old(text):
    """{code: (style, name)} from a pre-restyle capture."""
    out = {}
    for style, code, _meta, name in OLD_ITEM_RE.findall(text):
        out[code] = (style, html.unescape(re.sub('<[^>]+>', '', name)).strip())
    return out


def fetch():
    text = get(PAGE)
    SNAPSHOT.write_text(text, encoding='utf-8')
    rows = parse_page(text)
    print(f'snapshot: {len(rows)} colours -> {SNAPSHOT.relative_to(ROOT)}')

    IMAGES.mkdir(exist_ok=True)
    IMAGES_LARGE.mkdir(exist_ok=True)
    for r in rows:
        large = IMAGES_LARGE / f"{r['sku']}.jpg"
        small = IMAGES / f"{r['sku']}.jpg"
        if large.exists() and small.exists():
            continue
        large.write_bytes(get(LARGE_URL + r['sku'] + '.jpg', binary=True))
        im = Image.open(large).convert('RGB')
        s = im.copy()
        s.thumbnail((SMALL_EDGE, SMALL_EDGE), Image.LANCZOS)
        s.save(small, 'JPEG', quality=92, optimize=True)
        print(f"  {r['sku']}  {im.size[0]}x{im.size[1]}  {r['name']}")
        time.sleep(0.5)


def sample_color(path):
    """Median of a centre crop — identical to build_dataset's sample_color."""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    m = 0.2
    im = im.crop((int(w * m), int(h * m), int(w * (1 - m)), int(h * (1 - m))))
    a = np.asarray(im).reshape(-1, 3)
    return [int(v) for v in np.median(a, axis=0).round().astype(int)]


def build():
    if not SNAPSHOT.exists():
        sys.exit('no snapshot — run with --fetch first')
    rows = parse_page(SNAPSHOT.read_text(encoding='utf-8'))

    # Match the previous style's list to the current one BY NAME: the restyle
    # kept every surviving colour's name and changed its number, so a name is
    # what carries identity across it. Fuchsia is the one that also changed --
    # respelled "Fushia" on the new list -- and is paired explicitly.
    old = parse_old(SNAPSHOT_2019.read_text(encoding='utf-8')) \
        if SNAPSHOT_2019.exists() else {}
    RESPELLED = {'fuchsia': 'fushia'}
    old_by_name = {}
    for code, (style, name) in old.items():
        old_by_name[RESPELLED.get(name.lower(), name.lower())] = (style, code, name)

    colors = []
    for r in rows:
        large = IMAGES_LARGE / f"{r['sku']}.jpg"
        if not large.exists():
            sys.exit(f"missing image {large.name} — run with --fetch")
        rgb = sample_color(large)
        colors.append({
            'name': r['name'],
            'slug': ''.join(c if c.isalnum() else '-'
                            for c in r['name'].lower()).strip('-'),
            'sku': r['sku'],
            'code': r['code'],
            'hex': '#%02x%02x%02x' % tuple(rgb),
            'rgb': rgb,
            # corners=False: Toray's frames are edge-to-edge fabric, no
            # watermark. 418px clears NAP_MEASURABLE, so contrast is measured.
            'nap': nap(str(large), rgb),
            'image': f"images/{r['sku']}.jpg",
            'image_large': f"images/large/{r['sku']}.jpg",
            'orderable': r['orderable'],
            # Toray publishes no per-colour PAGE, but it does publish a
            # per-colour sample request. `source` stays the list the data was
            # actually read from; this is the deep link for the reader.
            'sample_url': (f'{SITE}/sample_request/index.php?addsku={r["sku"]}'
                           if r['orderable'] else None),
            'source': PAGE,
            'sources': ['swatches-st'],
        })
        was = old_by_name.get(r['name'].lower())
        if was:
            colors[-1]['former_skus'] = [f'{was[0]}-{was[1]}']
            if was[2].lower() != r['name'].lower():
                colors[-1]['name_variants'] = [was[2]]

    colors.sort(key=lambda c: c['code'])
    styles = sorted({r['style'] for r in rows})

    # Colours on the old list whose name is on no current one: dropped at the
    # restyle. They keep everything the record has -- name, number, the capture
    # that shows them -- and have no hex, because no photograph of style 2223
    # survives anywhere to sample.
    current_names = {c['name'].lower() for c in colors}
    historical = []
    for key, (style, code, name) in sorted(old_by_name.items(), key=lambda kv: kv[1][2]):
        if key in current_names:
            continue
        historical.append({
            'name': name,
            'slug': ''.join(ch if ch.isalnum() else '-' for ch in name.lower()).strip('-'),
            'sku': f'{style}-{code}',
            'code': code,
            'style': style,
            'hex': None, 'rgb': None, 'nap': None,
            'image': None, 'image_large': None,
            'last_seen': '2019-05-12',
            'evidence': ['swatches.ultrasuede.us ST list, style 2223'],
            'source': ARCHIVE_2019,
            'sources': ['swatches-st-2019'],
        })
    measured = sum(1 for c in colors if c['nap']
                   and c['nap']['contrast_source'] == 'measured')

    doc = {
        'meta': {
            'product': 'Ultrasuede® ST',
            'also_known_as': ['Ultrasuede® Soft'],
            'manufacturer': 'Toray',
            'status': 'current',
            'color_count': len(colors),
            'style_numbers': [
                {'number': s, 'era': 'current',
                 'note': 'from the swatch number on every ST listing'}
                for s in styles
            ],
            'compiled': time.strftime('%Y-%m-%d'),
            'about': (
                'Read from Toray’s own swatch site, swatches.ultrasuede.us — the same '
                'site LT was reconstructed from, which now lists only ST and HP. ST is '
                'still current, so this is the live page rather than the archive.'
            ),
            'rebuild': ('python3 scraping/build_st.py --fetch && '
                        'python3 scraping/build_st.py'),
            'color_note': (
                'hex/rgb are sampled from Toray’s swatch photographs, not official '
                'Toray colour values, and are approximate. Each is the median of a '
                'centre crop — the same measurement used for LT and LX, so the three '
                'are comparable. Enlarged views are 418px, the same size as LT’s large '
                'captures, and the frames are edge-to-edge fabric with no watermark, so '
                'the plain centre crop applies rather than the corner-patch variant.'
            ),
            'nap_note': (
                f'Every colour carries a `nap` block measured the same way as LT’s and '
                f'meaning the same thing. At 418px all {measured} clear the 300px '
                f'minimum, so contrast is measured throughout and none falls back to '
                f'the curve fitted on LT.'
            ),
            'coverage_note': (
                'This is what the swatch site currently lists. Earlier ST ranges were '
                'wider — Field’s catalogues from 2003–2010 print ST colours under 45" '
                'numbers that were later restyled to 58" ones — and none of that history '
                'is here; see research/FINDINGS.md for what is known of it.'
            ),
            'specifications': {
                'composition': ('75% polyester ultra-microfiber non-woven (30% '
                                'plant-based) with 25% non-fibrous polyurethane binder'),
                'width': '58" / 1,480mm',
                'weight': 'approx. 6.8 oz per sq. yard / 230g per sq. meter',
                'thickness': '0.7mm',
                'style_number': '8023',
                'source': 'https://www.ultrasuede.us/products/st.html',
                'note': ('From Toray’s own product page; the swatch listing publishes '
                         'no specification text. Style number agrees with the 8023- '
                         'prefix on every current swatch number.'),
            },
        },
        'sources': [
            {'id': 'swatches-st', 'url': PAGE,
             'note': 'live Toray swatch site; snapshotted in scraping/st_page.html'},
        ],
        'colors': colors,
        'historical_colors': historical,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(f'wrote {OUT.relative_to(ROOT)}: {len(colors)} colours, '
          f'{measured} with measured nap, {len(historical)} historical')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true')
    a = ap.parse_args()
    fetch() if a.fetch else build()
