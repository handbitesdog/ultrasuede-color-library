#!/usr/bin/env python3
"""Build ../shammy.json from 浅草ゆうらぶ's Shammy®707J page.

Shammy® 707J is a Japanese suede-like artificial leather, sold here by 浅草ゆうらぶ
(Asakusa Youlove). Like Lamous it is not an Ultrasuede product; it is in this
library because it is the same kind of cloth bought for the same kind of work.

The source is unlike the others. There are no per-colour photographs: the whole
range is one printed colour card, `shammy-color.jpg`, photographed as a 4-column
grid. So the colours are read out of that single image, and the codes and names
come from the page's own カラー選択 list — which lists all 42 in the card's own
column-major order, so the two line up without any OCR.

    python3 scraping/build_shammy.py --fetch    # snapshot page + colour card
    python3 scraping/build_shammy.py            # sample cells, write ../shammy.json

Two things worth knowing about the result:

  * **One capture, not 42.** Every colour is read from the same photograph under
    the same light, which makes them unusually consistent *with each other* and
    less comparable with the other products here than those are with each other.

  * **93 pixels per colour.** That is the cell height in the card, and it is the
    ceiling — there is no larger version of the card. Too small to measure nap
    from (build_dataset wants 300), so like Lamous these carry no nap block and
    are drawn from their crops.

The page's <title> says 全37色 (37 colours); its body, its colour list and the
card itself all say 42. The title is stale and 42 is used.
"""

import argparse
import json
import pathlib
import re
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

# Shared with the Toray products; nap_small measures a sub-300px frame and
# divides out the resolution bias calibrated there.
from build_dataset import nap_small, nap_contrast

ROOT = pathlib.Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / 'scraping' / 'shammy_page.html'
CARD = ROOT / 'colorcards' / 'shammy_707j_color_card.jpg'
# A 678x445 close-up of the cloth from the same seller's page. It is the only
# Shammy image big enough for the plain contrast measurement, and it is what
# the card-derived contrasts are anchored to — see anchor_factor().
CLOSEUP = ROOT / 'colorcards' / 'shammy_707j_closeup.jpg'
CLOSEUP_URL = 'http://www.youlove.co.jp/SHAMMY-br.JPG'
# Clean fabric inside that frame: below the headline text, left of the
# "shmmy" watermark. 420x340, so the short edge clears NAP_MEASURABLE.
CLOSEUP_CROP = (10, 100, 430, 440)
IMAGES = ROOT / 'images'
IMAGES_LARGE = IMAGES / 'large'
OUT = ROOT / 'shammy.json'

PAGE = 'http://www.youlove.co.jp/shammy707j.html'
CARD_URL = 'http://www.youlove.co.jp/shammy-color.jpg'

# Grid of the colour card, found by projecting a not-the-paper mask onto each
# axis (paper is #eff0ea, sampled from the four corners) and taking the runs.
# Recorded rather than re-derived so a rebuild cannot silently re-grid a
# re-photographed card: if the card changes, these stop lining up and the
# uniformity check below fails loudly.
COLS = [(17, 228), (281, 494), (547, 760), (813, 1026)]
ROWS = [(44, 136), (179, 272), (315, 408), (450, 544), (586, 680), (722, 816),
        (858, 953), (995, 1089), (1131, 1225), (1266, 1360), (1402, 1496)]
# Column 0's top two cells are the SHAMMY word-mark and a blank, not colours —
# which is why the card holds 4x11 cells but 42 colours. Verified at build time.
COL0_SKIP = 2
INSET = 0.18          # keep the cell's printed edge out of the sample
SMALL_EDGE = 100

# Names are printed in Japanese only. These are transliterations, not source
# data, and are marked as such in the JSON — every one is a katakana rendering
# of an English colour word, so the mapping is mechanical rather than a reading.
EN = {
    'オフホワイト': 'Off White', 'サンドベージュ': 'Sand Beige',
    'ライトベージュ': 'Light Beige', 'タン': 'Tan', 'キャメル': 'Camel',
    'オークベージュ': 'Oak Beige', 'グレージュ': 'Greige',
    'チャコールグレー': 'Charcoal Grey', '濃グレージュ': 'Dark Greige',
    'アイスグレー': 'Ice Grey', 'ライトグレー': 'Light Grey',
    'ブルーグレー': 'Blue Grey', 'グレー': 'Grey', 'ダークグレー': 'Dark Grey',
    'ブラウン': 'Brown', 'コーヒーブラウン': 'Coffee Brown',
    'カーキブラウン': 'Khaki Brown', 'ダークブラウン': 'Dark Brown',
    'レッド': 'Red', 'ローズレッド': 'Rose Red', 'ホワイト': 'White',
    'ラベンダー': 'Lavender', 'パープル': 'Purple', 'ターコイズ': 'Turquoise',
    'エメラルド': 'Emerald', 'ワサビ': 'Wasabi', 'グリーンティー': 'Green Tea',
    'グリーン': 'Green', 'フォレストグリーン': 'Forest Green',
    'ディープグリーン': 'Deep Green', 'ワイン': 'Wine',
    'コーラルピンク': 'Coral Pink', 'ピンク': 'Pink', 'イエロー': 'Yellow',
    'オレンジ': 'Orange', 'サンセットオレンジ': 'Sunset Orange',
    'スカイブルー': 'Sky Blue', 'コバルトブルー': 'Cobalt Blue',
    'ロイヤルブルー': 'Royal Blue', 'ネイビー': 'Navy', 'インディゴ': 'Indigo',
    'ブラック': 'Black',
}

UA = 'ultrasuede-color-library/1.0 (+https://github.com/gwbischof/ultrasuede-color-library)'


def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = r.read()
    return d if binary else d.decode('utf-8')


def parse_page(text):
    """[(code, japanese name)] from the page's カラー選択 list, in card order."""
    flat = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', text))
    i = flat.find('カラー選択')
    if i < 0:
        sys.exit('カラー選択 list not found — the page layout may have changed')
    pairs = re.findall(r'((?:SR\d{1,2}|\d{2}[YWR]))-(\S+)', flat[i:i + 2000])
    seen, out = set(), []
    for code, name in pairs:
        if code in seen:
            continue
        seen.add(code)
        out.append((code, name))
    return out


def lum(rgb):
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]


def anchor_factor(card_naps):
    """How much the 93px card cells overstate contrast, measured not assumed.

    nap_small already divides out the resolution bias calibrated on LX, but that
    calibration was built by downsampling clean 800px originals. These cells are
    crops of a scan that was JPEG'd once already, and the blocking survives the
    de-noise step as if it were cloth — so they come out high even after the
    correction.

    The close-up is the control: same fabric, same seller, 445px short edge, so
    the plain measurement applies. Comparing it against the card cells nearest
    its own lightness gives the factor the card is out by. Divided out below.
    """
    im = Image.open(CLOSEUP).convert('RGB').crop(CLOSEUP_CROP)
    tmp = CLOSEUP.with_suffix('.crop.jpg')
    im.save(tmp, 'JPEG', quality=96)
    truth = nap_contrast(str(tmp))
    rgb = np.median(np.asarray(im).reshape(-1, 3), axis=0).round().astype(int)
    tmp.unlink()
    if truth is None:
        return 1.0, None

    L = lum(rgb)
    near = sorted(card_naps, key=lambda cn: abs(lum(cn[0]) - L))[:5]
    ratios = sorted(cn[1] / truth for cn in near)
    factor = ratios[len(ratios) // 2]
    return factor, {
        'closeup': CLOSEUP_URL,
        'closeup_crop_px': [im.size[0], im.size[1]],
        'closeup_contrast': round(truth, 2),
        'closeup_luminance': round(float(L), 1),
        'card_contrast_at_that_lightness': [round(cn[1], 2) for cn in near],
        'factor': round(factor, 3),
    }


def cells():
    """Card cells in column-major order — the order the page lists colours in."""
    out = []
    for ci, (x0, x1) in enumerate(COLS):
        for (y0, y1) in (ROWS[COL0_SKIP:] if ci == 0 else ROWS):
            out.append((x0, x1, y0, y1))
    return out


def fetch():
    text = get(PAGE)
    SNAPSHOT.write_text(text, encoding='utf-8')
    print(f'snapshot: {SNAPSHOT.relative_to(ROOT)}')
    CARD.parent.mkdir(exist_ok=True)
    CARD.write_bytes(get(CARD_URL, binary=True))
    im = Image.open(CARD)
    print(f'colour card: {im.size[0]}x{im.size[1]} -> {CARD.relative_to(ROOT)}')


def build():
    if not SNAPSHOT.exists() or not CARD.exists():
        sys.exit('no snapshot — run with --fetch first')
    colours = parse_page(SNAPSHOT.read_text(encoding='utf-8'))
    grid = cells()
    if len(colours) != len(grid):
        sys.exit(f'{len(colours)} colours listed but {len(grid)} cells on the card')

    im = Image.open(CARD).convert('RGB')
    a = np.asarray(im).astype(float)

    # The two skipped cells must not look like colours: the word-mark is busy
    # and the one under it is bare paper. If a re-photographed card shifts the
    # grid, this is what catches it.
    for (y0, y1) in ROWS[:COL0_SKIP]:
        sd = a[y0:y1, COLS[0][0]:COLS[0][1]].std(axis=(0, 1)).mean()
        if 1.0 < sd < 30.0:
            sys.exit(f'skipped cell at y={y0} looks like a swatch (sd {sd:.1f}) '
                     '— the grid may no longer match the card')

    IMAGES.mkdir(exist_ok=True)
    IMAGES_LARGE.mkdir(exist_ok=True)

    out = []
    for (code, jp), (x0, x1, y0, y1) in zip(colours, grid):
        dx, dy = int((x1 - x0) * INSET), int((y1 - y0) * INSET)
        patch = a[y0 + dy:y1 - dy, x0 + dx:x1 - dx].reshape(-1, 3)
        rgb = [int(v) for v in np.median(patch, axis=0).round().astype(int)]

        crop = im.crop((x0, y0, x1, y1))
        large = IMAGES_LARGE / f'shammy-{code}.jpg'
        small = IMAGES / f'shammy-{code}.jpg'
        crop.save(large, 'JPEG', quality=92, optimize=True)
        s = crop.copy()
        s.thumbnail((SMALL_EDGE, SMALL_EDGE), Image.LANCZOS)
        s.save(small, 'JPEG', quality=92, optimize=True)

        out.append({
            'name': EN.get(jp, code),
            'name_ja': jp,
            'name_source': 'ja',       # the English name is a transliteration
            'slug': code.lower(),
            'sku': code,
            'code': code,
            'hex': '#%02x%02x%02x' % tuple(rgb),
            'rgb': rgb,
            'nap': None,       # filled in below, once the anchor is known
            'image': f'images/shammy-{code}.jpg',
            'image_large': f'images/large/shammy-{code}.jpg',
            'source': PAGE,
            'sources': ['youlove-shammy-707j'],
        })

    # Contrast for every cell, then the anchor, then divide it out.
    raw_naps = []
    for c in out:
        blk = nap_small(str(IMAGES_LARGE / f"shammy-{c['code']}.jpg"), c['rgb'])
        c['nap'] = blk
        if blk:
            raw_naps.append((c['rgb'], blk['contrast']))
    factor, anchor = anchor_factor(raw_naps)
    for c in out:
        if c['nap']:
            c['nap']['contrast'] = round(c['nap']['contrast'] / factor, 2)
            c['nap']['contrast_source'] = 'measured-small-frame-anchored'
            c['nap']['contrast_anchor_factor'] = round(factor, 3)

    out.sort(key=lambda c: c['code'])

    doc = {
        'meta': {
            'product': 'Shammy® 707J',
            'also_known_as': ['シャミー®707J'],
            'manufacturer': None,
            'status': 'current',
            'color_count': len(out),
            'compiled': time.strftime('%Y-%m-%d'),
            'about': (
                'Shammy® 707J is a Japanese suede-like artificial leather, a different '
                'product from Toray’s Ultrasuede. Read from 浅草ゆうらぶ (Asakusa '
                'Youlove), whose product page carries the whole range as one printed '
                'colour card plus a colour list naming every code.'
            ),
            'rebuild': ('python3 scraping/build_shammy.py --fetch && '
                        'python3 scraping/build_shammy.py'),
            'naming_note': (
                'Names are printed in Japanese only. `name_ja` is as printed; `name` is '
                'a transliteration — every one is a katakana rendering of an English '
                'colour word — and is not source data.'
            ),
            'color_note': (
                'hex/rgb are read from one photographed colour card, not from official '
                'values, and are approximate. Each is the median of a centre crop of its '
                'cell, inset to keep the printed cell edge out of the sample. Because '
                'all 42 come from a single capture under one light they are unusually '
                'consistent with each other, and correspondingly less comparable with '
                'the other products here than those are with each other — those were '
                'photographed a colour at a time.'
            ),
            'nap_note': (
                'Every colour carries a `nap` block, and it goes through two corrections '
                'rather than one. A cell is 93px tall, far under build_dataset’s 300px '
                'threshold, so contrast is measured on the small frame and the bias '
                'calibrated on LX divided out. That alone left these 1.4-1.6x above what '
                'the same cloth measures on a properly sized frame: the LX calibration '
                'was built by downsampling clean originals, while these cells are crops '
                'of a scan that was JPEG’d once already, and the blocking survives the '
                'de-noise step as if it were cloth. So they are anchored as well — the '
                'seller’s own 678x445 close-up is the control, measured the plain way and '
                'compared against the card cells nearest its lightness. meta.nap_anchor '
                'records that comparison. Even so this is the roughest contrast in the '
                'library: good enough to draw a swatch that reads as suede, not good '
                'enough to compare against LT or ST.'
            ),
            'coverage_note': (
                'The card header, the page body and the colour list all say 42 '
                '("全42色") and all three agree on the same 42 codes. The page <title> '
                'says 全37色; it is stale and is not used.'
            ),
            'specifications': {
                'width': '1,150mm (115cm)',
                'roll': '115cm × 30m',
                'thickness': '0.5mm (+0.1 / -0.05)',
                'composition': 'Polyester 65%, Polyurethane 35%',
                'weight': '140 g/m²',
                'product_code': '707J',
                'source': PAGE,
                'spec_sheet': 'http://www.youlove.co.jp/shammy-about.jpg',
            },
            'nap_anchor': anchor,
            'not_recorded': [
                'manufacturer — the listing names no company',
            ],
        },
        'sources': [
            {'id': 'youlove-shammy-707j', 'url': PAGE,
             'note': ('retailer product page; colour card at shammy-color.jpg, '
                      'snapshotted to colorcards/')},
        ],
        'colors': out,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(f'wrote {OUT.relative_to(ROOT)}: {len(out)} colours')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true')
    a = ap.parse_args()
    fetch() if a.fetch else build()
