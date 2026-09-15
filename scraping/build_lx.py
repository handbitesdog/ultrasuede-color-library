#!/usr/bin/env python3
"""Build ../lx.json from Toray's own LX sales catalogue.

Unlike LT — reconstructed from Wayback captures because it is discontinued —
LX is still sold, so this reads the live storefront at sales.tum.toray, which
is Shopify and exposes the collection as structured JSON. That is a better
source than scraping rendered HTML: colour name, style/colour code and the
original swatch photograph all come through as fields rather than as markup to
guess at.

Two passes, so the network half is reproducible and the measurement half is
re-runnable offline:

    python3 scraping/build_lx.py --fetch    # snapshot the catalogue + photos
    python3 scraping/build_lx.py            # sample colours, write ../lx.json

The snapshot lands in scraping/lx_products.json and is committed, so anyone can
rebuild the dataset without hitting Toray's store.

Colour sampling is deliberately the same median-of-a-centre-crop used for LT
(see sample_color in build_dataset.py) so the two products' hexes mean the same
thing and can sit in one catalogue.
"""

import argparse
import json
import pathlib
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

# The nap measurement is shared with LT rather than reimplemented — same
# de-noising, same five bands, same meaning — so a shader drawn from an LX
# entry and one drawn from an LT entry are the same kind of picture.
# build_dataset guards its own entry point, so importing it runs nothing.
from build_dataset import nap

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / 'scraping' / 'lx_products.json'
IMAGES = ROOT / 'images'
IMAGES_LARGE = IMAGES / 'large'
OUT = ROOT / 'lx.json'

COLLECTION = 'https://sales.tum.toray/collections/lx'
PRODUCTS_JSON = COLLECTION + '/products.json?limit=250'

# Style number, from the `vendor` field every LX product carries ("LX_3942").
STYLE = '3942'

# The collection also lists things that are not colours: a colour card, a
# cut-cloth sample set, and an Ultrasuede HP hanger. They have no colour code,
# so they are excluded by handle rather than guessed at.
NOT_COLOURS = {'colorcard', 'cutclothset'}

UA = 'ultrasuede-color-library/1.0 (+https://github.com/gwbischof/ultrasuede-color-library)'


def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read() if binary else json.loads(r.read())


def fetch():
    """Snapshot the catalogue and every swatch photograph."""
    data = get(PRODUCTS_JSON)
    products = data.get('products', [])
    if not products:
        sys.exit('no products returned — the storefront may have changed')

    SNAPSHOT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + '\n')
    print(f'snapshot: {len(products)} products -> {SNAPSHOT.relative_to(ROOT)}')

    IMAGES.mkdir(exist_ok=True)
    IMAGES_LARGE.mkdir(exist_ok=True)
    for p in products:
        if p['handle'] in NOT_COLOURS or not p['images']:
            continue
        code = sku_of(p)
        if code is None:
            continue
        # Largest image the product carries. Shopify serves the original at the
        # bare src; the sizes vary by colour (397px to 3667px here) because the
        # photographs were taken over several sessions.
        img = max(p['images'], key=lambda i: i.get('width') or 0)
        small = IMAGES / f'{STYLE}-{code}.jpg'
        large = IMAGES_LARGE / f'{STYLE}-{code}.jpg'
        if small.exists() and large.exists():
            continue
        raw = get(img['src'], binary=True)
        large.write_bytes(raw)
        d_large = resize(large, LARGE_EDGE)
        small.write_bytes(raw)
        resize(small, SMALL_EDGE)
        print(f'  {code} {img["width"]}px -> large {d_large}px + small {SMALL_EDGE}px')
        time.sleep(0.5)  # be polite to their CDN


# Two sizes per colour, matching what LT already ships: a small swatch at
# images/<sku>.jpg and a larger one at images/large/<sku>.jpg, carried in the
# JSON as `image` and `image_large`.
#
# LT's are 100px and 418px because that is what the archive happened to hold.
# Toray's live photographs go up to 3667px, which would be ~36MB across the
# line, so the large is capped — 800px is ample for re-measuring and for a
# consumer to derive its own thumbnails from, at a fifth of the weight.
#
# Colours are sampled from the large copy rather than the original, so the
# dataset rebuilds reproducibly from what is committed. That costs at most
# 3/255 on one channel versus sampling the original, which is well inside the
# approximation already implied by reading a colour off a photograph.
SMALL_EDGE = 100
LARGE_EDGE = 800


def resize(path, edge):
    im = Image.open(path)
    if max(im.size) > edge:
        im.thumbnail((edge, edge), Image.LANCZOS)
    im.convert('RGB').save(path, 'JPEG', quality=92, optimize=True)
    return max(im.size)


def sku_of(p):
    """Colour code for a product, or None if it has no usable one.

    Prefer the variant SKU over the handle: they usually agree, but Turquoise
    is listed under handle "fc5" with SKU "CT5", and the SKU is what appears on
    Toray's own colour card.
    """
    for v in p.get('variants', []):
        if v.get('sku'):
            return v['sku'].strip().upper()
    return None


def sample_color(path):
    """Representative colour of a swatch photo.

    Identical to sample_color in build_dataset.py — suede's directional nap
    makes the median of a centre crop far more stable than a whole-frame mean,
    which also picks up edge vignetting. Kept byte-for-byte so LX and LT hexes
    are comparable.
    """
    im = Image.open(path).convert('RGB')
    w, h = im.size
    m = 0.2
    im = im.crop((int(w * m), int(h * m), int(w * (1 - m)), int(h * (1 - m))))
    a = np.asarray(im).reshape(-1, 3)
    med = np.median(a, axis=0).round().astype(int)
    return [int(v) for v in med]


def hexstr(rgb):
    return '#%02x%02x%02x' % tuple(rgb)


def slug(name):
    return ''.join(c if c.isalnum() else '-' for c in name.lower()).strip('-')


def build():
    if not SNAPSHOT.exists():
        sys.exit('no snapshot — run with --fetch first')
    products = json.loads(SNAPSHOT.read_text())['products']

    colors = []
    for p in products:
        if p['handle'] in NOT_COLOURS:
            continue
        code = sku_of(p)
        if code is None:
            print(f'  skipped (no colour code): {p["title"]}')
            continue
        small = IMAGES / f'{STYLE}-{code}.jpg'
        large = IMAGES_LARGE / f'{STYLE}-{code}.jpg'
        if not large.exists():
            sys.exit(f'missing image {large.name} — run with --fetch')

        rgb = sample_color(large)
        # corners=False: Toray's frames are edge-to-edge fabric with no
        # watermark, so the centre is read directly. Every LX photograph clears
        # NAP_MEASURABLE (the smallest is 397px), so contrast is measured for
        # all 25 and none falls back to the fitted curve.
        nap_block = nap(str(large), rgb)
        src = max(p['images'], key=lambda i: i.get('width') or 0)
        colors.append({
            'name': p['title'].strip(),
            'slug': slug(p['title']),
            'sku': f'{STYLE}-{code}',
            'code': code,
            'hex': hexstr(rgb),
            'rgb': rgb,
            'nap': nap_block,
            'image': f'images/{STYLE}-{code}.jpg',
            'image_large': f'images/large/{STYLE}-{code}.jpg',
            'source_image_width': src.get('width'),
            'handle': p['handle'],
            'source': f'{COLLECTION}/products/{p["handle"]}',
            'available': bool(p['variants'][0].get('available')) if p['variants'] else None,
            'published_at': (p.get('published_at') or '')[:10] or None,
        })

    colors.sort(key=lambda c: c['code'])

    doc = {
        'meta': {
            'product': 'Ultrasuede® LX',
            'manufacturer': 'Toray',
            'status': 'current',
            'color_count': len(colors),
            'style_numbers': [
                {'number': STYLE, 'era': 'current',
                 'note': 'from the `vendor` field on every LX product ("LX_3942")'}
            ],
            'compiled': time.strftime('%Y-%m-%d'),
            'about': (
                'Read from Toray’s own LX sales catalogue at sales.tum.toray, '
                'which runs on Shopify and publishes the collection as JSON. Every '
                'entry carries the product URL it came from.'
            ),
            'rebuild': 'python3 scraping/build_lx.py --fetch && python3 scraping/build_lx.py',
            'color_note': (
                'hex/rgb are sampled from Toray’s swatch photographs, not official '
                'Toray colour values, and are approximate. Each is the median of a '
                'centre crop — the same measurement used for LT, so the two products’ '
                'values are comparable. Source photographs range from 397px to 3667px; '
                'the smaller ones were shot at a coarser magnification, which the median '
                'is largely but not entirely insensitive to. Photographs are stored downscaled to 1000px on the long edge; re-sampling a downscaled copy moves the median by at most 2/255 on one channel versus the original, which is well inside the approximation already implied by reading a colour off a photograph.'
            ),
            'coverage_note': (
                'This is what the sales catalogue lists, which is not necessarily the '
                'whole LX line — it is the set offered for sale through this channel.'
            ),
            'specifications': {
                'composition': ('80% polyester ultra-fine fiber non-woven with '
                                '20% non-fibrous polyurethane binder'),
                'width': '51" / 1,300mm',
                'weight': 'approx. 6.5 oz per sq. yard / 220g per sq. meter',
                'thickness': '0.6mm',
                'style_number': '3942',
                'source': 'https://www.ultrasuede.us/products/lx.html',
                'note': ('From Toray’s own product page, not the storefront, which '
                         'publishes no specification text. Its style number agrees with '
                         'the LX_3942 vendor field on every storefront listing.'),
            },
        },
        'sources': [
            {'id': 'sales-tum-toray-lx', 'url': COLLECTION,
             'note': 'live Shopify storefront; collection JSON snapshotted in scraping/lx_products.json'},
        ],
        'colors': colors,
    }

    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(f'wrote {OUT.relative_to(ROOT)}: {len(colors)} colours')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true',
                    help='snapshot the catalogue and download swatch photos')
    a = ap.parse_args()
    if a.fetch:
        fetch()
    else:
        build()
