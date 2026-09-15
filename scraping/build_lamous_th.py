#!/usr/bin/env python3
"""Build ../lamous-th.json from Mitokuya's Lamous®-TH catalogue page.

Lamous® is a Japanese suede-like artificial leather, a different product from
Toray's Ultrasuede — it is in this library because it is the same kind of cloth
bought for the same kind of work, not because it is the same brand.

The source is one page: 美徳屋 (Mitokuya), a Japanese retailer, which lists the
whole TH grade as a colour picker on a single product. The page states outright
that the grade has 49 colours ("49色取り揃え"), and the picker lists exactly 49,
so the coverage question that hangs over the LX import does not arise here.

Two passes, like the other builders:

    python3 scraping/build_lamous_th.py --fetch   # snapshot page + photos
    python3 scraping/build_lamous_th.py           # sample colours, write JSON

Three things differ from LX, all forced by the source:

  * Colours have NO NAMES. The picker and the cart both identify a colour by
    its code alone ("カラー: TH431"), so `name` is the code. Inventing names
    would be inventing data.

  * The photographs carry a caption bar across the bottom with the code printed
    on it. It sits at 85-90% of frame height on all 49, so they are cropped to
    the top 84% on the way in — the bar is the seller's overlay, not the cloth,
    and leaving it in would put it in the tile as well as in the sample.

  * Contrast is measured on a SMALL FRAME. These are ~200px once the caption is
    off, under build_dataset's NAP_MEASURABLE of 300 — but that threshold is
    cautious: downsampling LX's 800px frames to 197px and re-measuring loses a
    median of 5% across 21 colours. So contrast is measured and the calibrated
    bias divided out, via nap_small. Each entry records contrast_frame_px and
    contrast_res_factor so the correction stays visible. Nothing is modelled —
    the curve that would model it was fitted on Ultrasuede LT and has no
    business describing a different manufacturer's cloth.
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

# Shared with the Toray products so a Lamous shader and an LT shader are the
# same kind of picture. nap_small measures a frame under the 300px threshold
# and divides out the resolution bias calibrated there.
from build_dataset import nap_small

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / 'scraping' / 'lamous_th_page.html'
IMAGES = ROOT / 'images'
IMAGES_LARGE = IMAGES / 'large'
OUT = ROOT / 'lamous-th.json'

PAGE = 'https://mitokuya.co.jp/shop/detail.html?item_number=1&sku1=44'
ITEM_BASE = 'https://mitokuya.co.jp/items/1/'

# Caption bar starts at 85.3%-90.1% of frame height across all 49; 84% clears
# it everywhere with margin to spare.
KEEP = 0.84
SMALL_EDGE = 100

UA = 'ultrasuede-color-library/1.0 (+https://github.com/gwbischof/ultrasuede-color-library)'


def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = r.read()
    return d if binary else d.decode('utf-8')


def parse_page(text):
    """The colour picker: [(sku1, code, image filename)], in page order."""
    m = re.search(r'<div class="sku1"[^>]*>\s*<ul>(.*?)</ul>', text, re.S)
    if not m:
        sys.exit('colour picker not found — the page layout may have changed')
    items = [(int(s), html.unescape(re.sub('<[^>]+>', '', lab)).strip())
             for s, lab in re.findall(
                 r'<li[^>]*data-sku1="(\d+)"[^>]*>(.*?)</li>', m.group(1), re.S)]

    files = sorted(set(re.findall(r'\.\./items/1/([^"\']+\.jpg)', text, re.I)))
    best = {}
    for fn in files:
        c = re.search(r'(th\d+)', fn, re.I)
        if not c:
            continue
        code = c.group(1).upper()
        # Frame 00 is the folded product shot — both faces of the cloth against
        # a studio background — not a flat swatch. TH001 is the only colour that
        # has one, and it also has a flat frame; prefer that.
        if code not in best or best[code].startswith('00'):
            best[code] = fn

    out = []
    for sku, code in items:
        if code not in best:
            print(f'  no photograph for {code}')
            continue
        out.append((sku, code, best[code]))
    return out


def crop_caption(im):
    """Drop the seller's caption bar off the bottom of a swatch photo."""
    w, h = im.size
    return im.crop((0, 0, w, int(h * KEEP)))


def fetch():
    text = get(PAGE)
    SNAPSHOT.write_text(text, encoding='utf-8')
    rows = parse_page(text)
    print(f'snapshot: {len(rows)} colours -> {SNAPSHOT.relative_to(ROOT)}')

    IMAGES.mkdir(exist_ok=True)
    IMAGES_LARGE.mkdir(exist_ok=True)
    for _, code, fn in rows:
        large = IMAGES_LARGE / f'{code}.jpg'
        small = IMAGES / f'{code}.jpg'
        if large.exists() and small.exists():
            continue
        raw = large.with_suffix('.tmp')
        raw.write_bytes(get(ITEM_BASE + fn, binary=True))
        im = crop_caption(Image.open(raw).convert('RGB'))
        im.save(large, 'JPEG', quality=92, optimize=True)
        s = im.copy()
        s.thumbnail((SMALL_EDGE, SMALL_EDGE), Image.LANCZOS)
        s.save(small, 'JPEG', quality=92, optimize=True)
        raw.unlink()
        print(f'  {code}  {im.size[0]}x{im.size[1]} (caption cropped)')
        time.sleep(0.4)


def sample_color(path):
    """Median of a centre crop — the same measurement LT and LX use."""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    m = 0.2
    im = im.crop((int(w * m), int(h * m), int(w * (1 - m)), int(h * (1 - m))))
    a = np.asarray(im).reshape(-1, 3)
    return [int(v) for v in np.median(a, axis=0).round().astype(int)]


def hexstr(rgb):
    return '#%02x%02x%02x' % tuple(rgb)


def build():
    if not SNAPSHOT.exists():
        sys.exit('no snapshot — run with --fetch first')
    rows = parse_page(SNAPSHOT.read_text(encoding='utf-8'))

    colors = []
    for sku, code, _ in rows:
        large = IMAGES_LARGE / f'{code}.jpg'
        if not large.exists():
            sys.exit(f'missing image {large.name} — run with --fetch')
        rgb = sample_color(large)
        # corners=False: the caption bar is already cropped off, so the frame
        # is fabric edge to edge.
        nap_block = nap_small(str(large), rgb)
        colors.append({
            # No names exist for this line; the code is the identity.
            'name': code,
            'slug': code.lower(),
            'sku': code,
            'code': code,
            'hex': hexstr(rgb),
            'rgb': rgb,
            'nap': nap_block,
            'image': f'images/{code}.jpg',
            'image_large': f'images/large/{code}.jpg',
            'source': f'https://mitokuya.co.jp/shop/detail.html?item_number=1&sku1={sku}',
            'sources': ['mitokuya-lamous-th'],
        })

    colors.sort(key=lambda c: c['code'])

    doc = {
        'meta': {
            'product': 'Lamous®-TH',
            'also_known_as': ['ラムース®-TH'],
            'manufacturer': None,
            'status': 'current',
            'color_count': len(colors),
            'compiled': time.strftime('%Y-%m-%d'),
            'about': (
                'Lamous® is a Japanese suede-like artificial leather, a different '
                'product from Toray’s Ultrasuede. It is here because it is the same '
                'kind of cloth bought for the same kind of work. Read from 美徳屋 '
                '(Mitokuya), a Japanese retailer, whose Lamous®-TH listing carries the '
                'whole grade as a colour picker on one page.'
            ),
            'rebuild': ('python3 scraping/build_lamous_th.py --fetch && '
                        'python3 scraping/build_lamous_th.py'),
            'naming_note': (
                'This line has no colour names. The picker and the cart both identify a '
                'colour by its code alone, so `name` is the code.'
            ),
            'color_note': (
                'hex/rgb are sampled from the retailer’s swatch photographs, not from '
                'official Lamous colour values, and are approximate. Each is the median '
                'of a centre crop — the same measurement used for LT and LX, so the '
                'three products’ values are comparable. The photographs carry a caption '
                'bar with the code printed across the bottom of the frame; it sits at '
                '85-90% of frame height on all 49 and is cropped off on the way in, so '
                'neither the sample nor the tile contains it.'
            ),
            'nap_note': (
                'Every colour carries a `nap` block, measured from its own photograph '
                'and meaning the same thing as LT’s. These frames are about 200px once '
                'the caption bar is cropped, under build_dataset’s 300px threshold — but '
                'that threshold turns out to be cautious. Downsampling LX’s 800px frames '
                'to 197px and re-measuring loses a median of 5% (21 colours, stdev 0.05), '
                'so the shortfall is a correctable bias rather than an absence. Contrast '
                'here is measured and then divided by that calibrated factor; each entry '
                'records contrast_frame_px and contrast_res_factor so the correction is '
                'visible rather than baked in. Nothing is modelled — the curve that would '
                'model it was fitted on Ultrasuede LT and has no business describing a '
                'different manufacturer’s cloth.'
            ),
            'coverage_note': (
                'The page states the grade has 49 colours ("49色取り揃え") and the picker '
                'lists 49, so this is the whole TH range rather than one channel’s '
                'selection.'
            ),
            'specifications': {
                'thickness': '0.58 (±0.05) mm',
                'width': '130cm',
                'roll': '130cm × 30m',
                'composition': 'Polyester 92%, Polyurethane 8%',
                'origin': 'Made in Japan',
                'source': PAGE,
            },
            'not_recorded': [
                'manufacturer — the listing names no company, only "Made in Japan"',
                'weight',
            ],
        },
        'sources': [
            {'id': 'mitokuya-lamous-th', 'url': PAGE,
             'note': ('retailer catalogue page; the colour picker carries the whole '
                      'grade. Snapshotted in scraping/lamous_th_page.html')},
        ],
        'colors': colors,
    }

    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(f'wrote {OUT.relative_to(ROOT)}: {len(colors)} colours')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true',
                    help='snapshot the page and download swatch photographs')
    a = ap.parse_args()
    fetch() if a.fetch else build()
