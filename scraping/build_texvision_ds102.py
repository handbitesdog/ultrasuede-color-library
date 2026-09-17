#!/usr/bin/env python3
"""Build ../texvision-ds102.json — the Korean faux suede sold as Texvision DS102.

Not an Ultrasuede product and not a Japanese one: a Korean PU-impregnated
polyester microfibre suede, 0.6mm, sold on eBay by "What More Fabric" of Seoul.
The listing's own Item Specifics give Brand "Texvision" and MPN "0.6T DS102",
which is where the product name here comes from — see meta.identity_note for how
much weight that deserves.

    python3 scraping/build_texvision_ds102.py --fetch   # download swatch photos
    python3 scraping/build_texvision_ds102.py           # sample, write the JSON

This is the least precise dataset in the library, and the reasons are worth
stating rather than burying:

  * **The photographs are two shots, neither of them a plain swatch.** Thirteen
    are a flat piece on studio paper with a numbered badge and the colour name
    printed over the bottom right; the other twenty-eight are the cloth swirled
    into a rosette. Every other product here is shot flat and clean, so a centre
    crop is enough for them; here it would land on a badge or on whatever fold
    sits at the middle. The colour is therefore sampled from the flattest,
    averagely-lit cloth the frame has — see the sampling note further down for
    what that means and how each part of it is set.

  * **How far off that is, is measured, not guessed.** The listing also carries
    labelled 3x3 charts, and one covers colours 10-18. Sampling those cells and
    comparing gives a mean RGB distance of 27 and a worst case of 53, with
    luminance ratios between 0.96 and 1.23. So treat these as roughly +/-10% in
    luminance. That is worse than the rest of the library and better than
    nothing; MEASURED_AGAINST_CHART records the comparison.

    The chart cannot do better than that, and it is worth saying why rather
    than reading the number as precision. Its own three rows do not agree: the
    top two run 1.03 against the photographs and the bottom one 1.17, which is
    the chart's exposure rather than three colours of cloth all being wrong
    together. Read across rows one and two alone the mean distance is 19.

  * **No per-colour nap block.** What varies across one of these frames is folds,
    not nap, so there is no per-colour nap here to measure even though the
    images are large enough. Contrast comes from the chart instead — chart_nap.

eBay returns 403 to scripted fetches of the listing page, so the variation list
(name, stock flag, image id per colour) was captured from a browser session and
is committed as scraping/texvision_ds102_variations.json. The images themselves
come off eBay's CDN, which does answer, so --fetch still works unattended.
"""

import argparse
import json
import pathlib
import sys
import time
import urllib.request

import numpy as np
from PIL import Image

from build_dataset import nap_contrast

ROOT = pathlib.Path(__file__).resolve().parent.parent
VARIATIONS = ROOT / 'scraping' / 'texvision_ds102_variations.json'
IMAGES = ROOT / 'images'
IMAGES_LARGE = IMAGES / 'large'
OUT = ROOT / 'texvision-ds102.json'

LISTING = 'https://www.ebay.com/itm/223986181465'
LARGE_EDGE = 600
SMALL_EDGE = 100
PREFIX = 'ds102'

# Colour 10-18 as read off the seller's own labelled chart (image
# ZOUAAOSwBlFeoLCS, upper band of each 3x3 cell, clear of the badge and the
# printed name), against the same colours read off their drape photographs.
# Kept so the claim in the docstring can be re-checked rather than trusted.
# The listing carries exactly one labelled 3x3 chart, covering colours 10-18,
# at 533px a cell — flat fabric, and large enough for the plain measurement.
# It is the only DS102 image nap can honestly be read from, so it is committed.
CHART = ROOT / 'colorcards' / 'ds102_chart_10-18.jpg'
CHART_URL = 'https://i.ebayimg.com/images/g/ZOUAAOSwBlFeoLCS/s-l1600.jpg'

MEASURED_AGAINST_CHART = {
    'chart_image': 'https://i.ebayimg.com/images/g/ZOUAAOSwBlFeoLCS/s-l1600.jpg',
    'colors_compared': list(range(10, 19)),
    'mean_rgb_distance': 27,
    'max_rgb_distance': 53,
    'luminance_ratio_range': [0.96, 1.23],
    # The chart's three rows disagree with each other by more than the rule
    # being checked does: rows 1 and 2 read 1.03 against the photographs and
    # row 3 reads 1.17. Read on rows 1-2 alone the mean distance is 19. So this
    # bounds the dataset; it is not fine enough to choose a sampling rule with.
    'per_chart_row_luminance_ratio': [1.03, 1.03, 1.17],
    'mean_rgb_distance_rows_1_2': 19,
}

UA = 'ultrasuede-color-library/1.0 (+https://github.com/gwbischof/ultrasuede-color-library)'


def rows():
    if not VARIATIONS.exists():
        sys.exit(f'missing {VARIATIONS.name}')
    return json.load(VARIATIONS.open())['colors']


def fetch():
    IMAGES.mkdir(exist_ok=True)
    IMAGES_LARGE.mkdir(exist_ok=True)
    for n, name, _oos, size, iid, _vid in rows():
        large = IMAGES_LARGE / f'{PREFIX}-{n:02d}.jpg'
        small = IMAGES / f'{PREFIX}-{n:02d}.jpg'
        if large.exists() and small.exists():
            continue
        url = f'https://i.ebayimg.com/00/s/{size}/z/{iid}/$_57.JPG'
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            large.write_bytes(r.read())
        im = Image.open(large).convert('RGB')
        im.thumbnail((LARGE_EDGE, LARGE_EDGE), Image.LANCZOS)
        im.save(large, 'JPEG', quality=92, optimize=True)
        s = im.copy()
        s.thumbnail((SMALL_EDGE, SMALL_EDGE), Image.LANCZOS)
        s.save(small, 'JPEG', quality=92, optimize=True)
        print(f'  {n:02d} {name}')
        time.sleep(0.3)


# ----------------------------------------------------------------- sampling ---
#
# The 41 photographs are two different shots, and the split is clean. Thirteen
# are a flat piece laid on studio paper, shot from above, with a numbered badge
# and the colour name printed across the bottom right; the other twenty-eight
# are the cloth swirled into a rosette. Counting studio paper in the
# bottom-right quadrant separates them with nothing in between — 16.5% to 42.8%
# on the thirteen, under 0.25% on the twenty-eight — so `shot` can be recorded
# per colour and a reader can see which photographs are the good ones.
#
# Nothing downstream needs the distinction, though, because one rule answers
# both compositions: sample where the cloth is flat. On a flat piece that means
# everything except the badge, the printed name and the shadow under the lifted
# pinked edge. On a swirl it means the broad faces between the folds. Both are
# the same question asked of the picture — where is there cloth and nothing
# happening to it — and it is asked in three parts.
#
# **What is not cloth.** Studio paper, as before: very bright (min channel over
# 245) and nearly neutral (spread under 8). The rule is tight on purpose. A
# looser one eats the pale fabrics themselves — at min > 225 it masked 59% of
# Light Gray's frame and 26% of Ivory's, and dragged both towards their own
# shadows.
#
# **What is an edge.** The badge rim, the printed glyphs, the pinked zigzag and
# the paper boundary are all hard; fold shading and nap are not. So the gradient
# of blurred log luminance is measured, and anything over six times the frame's
# own median counts as an edge. Log, because a shading gradient is a ratio and a
# threshold set on it then means the same thing on Raven as on Ivory; the
# frame's own median, because a dark crumpled swirl runs an order of magnitude
# hotter than a flat card and one constant either passes everything on the first
# or nothing on the second. Six leaves 524 to 3165 clean windows per frame.
#
# **Where it is flat.** Every 72px window clear of both of those is scored by
# how much its luminance drifts across it — the standard deviation of a heavily
# blurred log luminance, which is fold shadow with the nap taken off it. The
# flattest half are the candidates.
#
# That is two of the three parts. The third is which of the flat places to
# believe, and the answer is the one the old whole-frame median already had
# right: the middle of the illumination spread. A flat plateau facing the lamp
# and a flat plateau in shadow are equally flat and are not the same colour, so
# among the flat windows the ones nearest the frame's median fabric luminance
# are kept. Measured on the nine colours the chart covers, what comes back sits
# at the 54th to 61st percentile of its own frame's light — the centre, which is
# what it was asked for, and not the lit side of the cloth.

SAMPLE_WINDOW = 72          # px of a 600px frame
SAMPLE_STRIDE = 8
SAMPLE_EDGE = 6.0           # x the frame's own median gradient
SAMPLE_FLAT = 50            # percentile of roughness that still counts as flat
SAMPLE_KEEP = 0.30          # of those, the share nearest the frame's median light
CARD_PAPER = 0.05           # paper in the bottom-right quadrant: 0.17+ or 0.002-


def _boxblur(x, r):
    """Box blur, three of which is near enough a Gaussian for a gradient map.

    PIL's own blur is here in build_dataset, but it will not take a float
    array, and log luminance is not an image.
    """
    k = 2 * r + 1
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (r, r)
        c = np.cumsum(np.pad(x, pad, mode='edge'), axis=axis)
        c = np.concatenate([np.zeros_like(np.take(c, [0], axis)), c], axis)
        hi = np.take(c, np.arange(k, c.shape[axis]), axis)
        lo = np.take(c, np.arange(0, c.shape[axis] - k), axis)
        x = (hi - lo) / k
    return x


def _integral(x):
    return np.pad(np.cumsum(np.cumsum(x, 0), 1), ((1, 0), (1, 0)))


def _boxes(ii, y, x, k):
    return ii[y + k, x + k] - ii[y, x + k] - ii[y + k, x] + ii[y, x]


def is_card_shot(path):
    """True for the thirteen flat-piece photographs, False for the swirls."""
    a = np.asarray(Image.open(path).convert('RGB')).astype(float)
    mx, mn = a.max(2), a.min(2)
    paper = (mn > 245) & ((mx - mn) < 8)
    h, w = paper.shape
    return bool(paper[h // 2:, w // 2:].mean() > CARD_PAPER)


def flat_color(path, ret_mask=False):
    """Colour of the flattest, averagely-lit cloth in the frame.

    One rule for both compositions — see the note above for why it is the
    question to ask and how each part of it is set.
    """
    a = np.asarray(Image.open(path).convert('RGB')).astype(float)
    lum = a @ (0.2126, 0.7152, 0.0722)
    L = np.log(np.maximum(lum, 1.0))
    edges = _boxblur(_boxblur(_boxblur(L, 2), 2), 2)      # nap gone, edges kept
    shade = _boxblur(_boxblur(_boxblur(L, 6), 6), 6)      # shading only
    gy, gx = np.gradient(edges)
    grad = np.hypot(gx, gy)
    mx, mn = a.max(2), a.min(2)
    paper = (mn > 245) & ((mx - mn) < 8)

    k, stride = SAMPLE_WINDOW, SAMPLE_STRIDE
    hard = paper | (grad > SAMPLE_EDGE * float(np.median(grad)))
    ih = _integral(hard.astype(float))
    i1, i2 = _integral(shade), _integral(shade * shade)
    ys = np.arange(0, shade.shape[0] - k + 1, stride)
    xs = np.arange(0, shade.shape[1] - k + 1, stride)
    Y, X = np.meshgrid(ys, xs, indexing='ij')
    n = float(k * k)
    clean = _boxes(ih, Y, X, k) == 0
    mean = _boxes(i1, Y, X, k) / n
    rough = np.sqrt(np.maximum(_boxes(i2, Y, X, k) / n - mean * mean, 0))
    if not clean.any():            # a frame with no quiet corner anywhere
        clean = np.ones_like(clean)

    flat = clean & (rough <= np.percentile(rough[clean], SAMPLE_FLAT))
    off = np.where(flat, np.abs(mean - np.median(shade[~paper])), np.inf)
    keep = np.argsort(off, axis=None)[:max(4, int(round(flat.sum() * SAMPLE_KEEP)))]

    mask = np.zeros(shade.shape, dtype=bool)
    for idx in keep:
        mask[Y.flat[idx]:Y.flat[idx] + k, X.flat[idx]:X.flat[idx] + k] = True
    rgb = [int(v) for v in np.median(a[mask], axis=0).round()]
    return (rgb, mask) if ret_mask else rgb


def chart_nap():
    """One nap block for the whole product, measured off the labelled chart.

    The drape photographs cannot give this. Measuring the same nine colours both
    ways, the drapes read 2.18x to 5.05x the chart (median 3.48, stdev 0.84) —
    fold shadow, not nap, and the spread is too wide to be a factor worth
    dividing out the way Shammy's is. So contrast comes from the chart cells,
    which are flat fabric at 533px.

    It is one number for all 41 rather than one each, because nine cells is what
    exists and they say the cloth is consistent: contrast 5.01-8.22, stdev 0.91,
    and its correlation with lightness is -0.33 over a sample that holds no dark
    colours at all. That supports a constant. It does not support a per-colour
    value, and it certainly does not support extrapolating a lightness curve
    down into blacks the chart never shows.

    The axis is set neutral. The nine measure [0.942, 1.021, 0.957] on average,
    within 0.06 of neutral and about two standard errors off it — reading a
    colour lean into that would be fitting nine samples harder than they can
    carry.
    """
    if not CHART.exists():
        return None, None
    im = Image.open(CHART).convert('RGB')
    S = im.size[0] // 3
    vals = []
    for r in range(3):
        for c in range(3):
            # top 60% of the cell: clear of the numbered badge and printed name,
            # and still 533x320, so the short edge clears NAP_MEASURABLE
            cell = im.crop((c*S + 8, r*S + 8, (c+1)*S - 8, r*S + int(S*0.60)))
            tmp = CHART.with_suffix('.cell.jpg')
            cell.save(tmp, 'JPEG', quality=96)
            v = nap_contrast(str(tmp))
            tmp.unlink()
            if v:
                vals.append(v)
    if not vals:
        return None, None
    vals.sort()
    contrast = round(vals[len(vals)//2], 2)
    block = {
        'axis': [1.0, 1.0, 1.0],
        'contrast': contrast,
        'contrast_source': 'product-constant',
    }
    detail = {
        'chart': CHART_URL,
        'cells_measured': len(vals),
        'cell_contrasts': [round(v, 2) for v in vals],
        'median': contrast,
        'colors_covered': list(range(10, 19)),
        'axis': 'neutral — the nine average [0.942, 1.021, 0.957], within 0.06 of it',
        'why_not_per_color': (
            'The drape photographs read 2.18-5.05x the chart for the same nine '
            'colours (median 3.48, stdev 0.84). That is fold shadow rather than '
            'nap, and the spread is too wide to divide out as a factor.'
        ),
    }
    return block, detail


def build():
    nap_block, nap_detail = chart_nap()
    colors = []
    for n, name, oos, _size, _iid, vid in rows():
        large = IMAGES_LARGE / f'{PREFIX}-{n:02d}.jpg'
        if not large.exists():
            sys.exit(f'missing {large.name} — run with --fetch')
        rgb = flat_color(large)
        colors.append({
            'name': name,
            'slug': ''.join(c if c.isalnum() else '-' for c in name.lower()).strip('-'),
            'sku': f'DS102-{n:02d}',
            'code': f'{n:02d}',
            'hex': '#%02x%02x%02x' % tuple(rgb),
            'rgb': rgb,
            'nap': dict(nap_block) if nap_block else None,
            # Which of the two shots this colour was photographed in. Does
            # not change how it was sampled — one rule serves both — but it
            # says how much of the frame was cloth to sample from.
            'shot': 'flat-piece' if is_card_shot(large) else 'swirl',
            'image': f'images/{PREFIX}-{n:02d}.jpg',
            'image_large': f'images/large/{PREFIX}-{n:02d}.jpg',
            'in_stock': not oos,
            # Deep link: ?var= selects this colour on the listing rather than
            # dropping the reader on whichever one eBay defaults to.
            'source': f'{LISTING}?var={vid}',
            'variation_id': vid,
            'sources': ['ebay-whatmorefabric-ds102'],
        })

    doc = {
        'meta': {
            'product': 'Texvision DS102 (0.6mm)',
            'also_known_as': ['Korean faux suede'],
            'manufacturer': None,
            'status': 'current',
            'color_count': len(colors),
            'compiled': time.strftime('%Y-%m-%d'),
            'about': (
                'A Korean PU-impregnated polyester microfibre suede, sold on eBay by '
                '"What More Fabric" of Seoul. Not an Ultrasuede product — the listing '
                'title uses the word generically — and not related to the Japanese '
                'products here beyond being the same kind of cloth.'
            ),
            'rebuild': ('python3 scraping/build_texvision_ds102.py --fetch && '
                        'python3 scraping/build_texvision_ds102.py'),
            'identity_note': (
                'Brand "Texvision" and MPN "0.6T DS102" are the listing’s own Item '
                'Specifics. Texvision is NOT the mill: searching the seller’s own store '
                'for it returns 66 listings spanning satin, spandex, lamb-skin faux '
                'leather, cheetah-print doe suede and more, so it is the house brand '
                'they file everything under. DS102 is the only identifier here that '
                'points at this particular cloth, and who actually weaves it is not '
                'recorded anywhere on the listing — hence manufacturer: null. For '
                'contrast, the same seller’s 0.6mm Chamude listing (eBay 370722409147) '
                'carries a real product brand and real mill colour codes (#6101, #6103, '
                '…); this one does not.'
            ),
            'naming_note': (
                'Colour names are the seller’s, and several are Pantone fashion-colour '
                'names (Castlerock, Blue Nights, Mood Indigo, Moonstruck, Wild Lime), '
                'which suggests they were assigned at resale rather than by the mill. '
                'The code is the seller’s position in their own list, 1 to 41 — it is '
                'NOT a manufacturer colour number, and it would change if they '
                'reordered the list. Do not treat it as stable identity the way LX’s '
                'CD8 or Lamous’s TH001 can be treated.'
            ),
            'color_note': (
                'The least precise dataset here. The photographs are not flat '
                'swatches: 13 are a flat piece on studio paper with a numbered badge '
                'and the colour name printed over the bottom right, and 28 are the '
                'cloth swirled into a rosette — see each colour’s shot. So hex/rgb is '
                'not the centre-crop median the other products use, which here would '
                'return a badge or whatever fold sits at the centre. It is the median '
                'over the flattest cloth in the frame: 72px windows holding no studio '
                'paper and no hard edge — the badge rim, the printed name, the pinked '
                'zigzag — ranked by how little the light drifts across them, and of '
                'the flattest half, the ones nearest the frame’s median fabric '
                'luminance, so that the sample is flat cloth under average light '
                'rather than the lit side of a fold. Checked against the seller’s own '
                'labelled chart for colours 10-18: mean RGB distance 27, worst 53, '
                'luminance ratios 0.96 to 1.23 — but the chart’s own three rows read '
                '1.03, 1.03 and 1.17 against the photographs, so a good part of that '
                'is the chart. Treat these as roughly +/-10% in luminance and do not '
                'compare them closely with the flat-shot products.'
            ),
            'measured_against_chart': MEASURED_AGAINST_CHART,
            'nap_note': (
                'One nap block, shared by all 41. It cannot come from the drape '
                'photographs: measuring the same nine colours off the drapes and off '
                'the listing’s one labelled chart, the drapes read 2.18-5.05x the chart '
                '(median 3.48, stdev 0.84) — fold shadow rather than nap, and too '
                'variable to divide out the way Shammy’s is. So contrast is measured on '
                'the chart’s nine cells, which are flat fabric at 533px, and the median '
                'given to every colour. Nine is what exists, and they say the cloth is '
                'consistent (5.01-8.22, stdev 0.91) with only a -0.33 correlation to '
                'lightness across a sample holding no dark colours — enough for a '
                'constant, not enough for a per-colour value or a curve. meta.nap_source '
                'records the measurement.'
            ),
            'nap_source': nap_detail,
            'coverage_note': (
                'This listing offers 41 colours, and its own sample-set option is '
                'captioned "Sample set 2026 ver (122 colors)", so the range is around '
                '122 and this is roughly a third of it. The other 81 are not for sale '
                'anywhere online that could be found: the seller’s store was searched '
                'for further DS102 listings and has none — their other suede listings '
                'are different products at other thicknesses (0.5, 0.7, 1, 1.4mm) or '
                'different cloths entirely, and the 122-colour set is specific to this '
                'listing rather than store-wide, since the Chamude listing carries its '
                'own separate sample swatch. Short of buying the physical sample set, '
                'the remaining 81 have no online source.'
            ),
            'specifications': {
                'thickness': '0.6mm',
                'width': '54 inch',
                'fiber_content': 'PET (Polyester) 90%, PU 10% after dissolving',
                'weight': '300g per yard / 240 GSM',
                'origin': 'South Korea',
                'source': LISTING,
            },
            'not_recorded': ['manufacturer — see identity_note'],
        },
        'sources': [
            {'id': 'ebay-whatmorefabric-ds102', 'url': LISTING,
             'note': ('eBay listing; variation list captured from a browser session '
                      'and committed as scraping/texvision_ds102_variations.json, '
                      'because eBay 403s scripted fetches of the page')},
        ],
        'colors': colors,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + '\n')
    print(f'wrote {OUT.relative_to(ROOT)}: {len(colors)} colours')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--fetch', action='store_true')
    a = ap.parse_args()
    fetch() if a.fetch else build()
