#!/usr/bin/env python3
"""Build ../lt.json from the archived captures under snapshots/.

Everything in the output traces back to a file in snapshots/ or an image in
../images/. Re-running is idempotent: no network access happens here, so the
dataset can be rebuilt and diffed offline.

Run:  python3 build_dataset.py
"""

import glob
import html
import json
import os
import re
from datetime import date
from urllib.parse import unquote

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WAYBACK = 'https://web.archive.org/web'

# ---------------------------------------------------------------- parsing ---

SWATCH_RE = re.compile(
    r'images/(\d{4})-(\d{4})\.jpg" alt=""></a><span>(.*?)</em><br>\s*(.*?)</span>',
    re.S)


def parse_lt_index(path):
    """Parse a swatches.ultrasuede.us search_result.php?product=LT capture."""
    t = open(path, encoding='utf-8', errors='replace').read()
    declared = re.search(r'\((\d+) items found\)', t)
    colors = {}
    for style, code, meta, name in SWATCH_RE.findall(t):
        colors[code] = {
            'name': html.unescape(name.strip()),
            'style': style,
            'orderable': 'addsku' in meta,
        }
    return {
        'declared': int(declared.group(1)) if declared else 0,
        'colors': colors,
    }


def parse_2005_page(path):
    """Parse the 2005 ultrasuede.com 'Ultrasuede light' swatch page (style 801).

    Colour cells render as a 4-digit code followed by the colour name.
    """
    t = open(path, encoding='utf-8', errors='replace').read()
    x = html.unescape(re.sub(r'<[^>]+>', '|', t))
    pairs = re.findall(r"\|\s*(\d{4})\s*\|+\s*([A-Za-z][A-Za-z '\-À-ÿ]{1,25}?)\s*\|", x)
    return {code: name.strip() for code, name in pairs}


def parse_2010_index(path):
    """Parse the 2010 ultrasuede.com search_result.php?product=Light capture."""
    t = open(path, encoding='utf-8', errors='replace').read()
    cells = re.findall(
        r'images/(\d{4})-(\d{4})\.jpg".*?<p class="color">(.*?)</p>', t, re.S)
    return {code: html.unescape(name.strip()) for _s, code, name in cells}


def parse_jungle(path):
    """Parse an Ultrasuede Light Jungle Collection swatch page."""
    t = open(path, encoding='utf-8', errors='replace').read()
    imgs = re.findall(r'src="([^"]*jungle/([a-z]+\d{3})\.jpg)"', t)
    x = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', t)))
    labels = re.findall(
        r'([A-Z][A-Za-z ]{1,20}?)\*?\s*Pattern:\s*(\d{3})\s*Color:\s*(\d{3})', x)
    in_stock = {s.strip() for s in re.findall(r'([A-Z][A-Za-z ]{1,20}?)\*\s*Pattern:', x)}
    out = []
    for (_url, stem), (name, pattern, color) in zip(imgs, labels):
        assert stem.endswith(color), f'{stem} does not match colour {color}'
        out.append({
            'name': name.strip(),
            'pattern': pattern,
            'color': color,
            'stem': stem,
            'in_stock': name.strip() in in_stock,
        })
    return out


def parse_jungle_2001(path):
    """Parse the 2001 b2b/JungleLight.html page.

    Same 17 patterns, but different markup and image names (`BCoug231.jpg`
    rather than `bcouger231.jpg`), and no in-stock asterisks — that convention
    only appears on the later products/swatches pages.
    """
    t = open(path, encoding='utf-8', errors='replace').read()
    imgs = re.findall(r'(?i)src="images/([A-Za-z]+\d{3})\.jpg"', t)
    x = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', t)))
    labels = re.findall(
        r'([A-Z][A-Za-z ]{1,20}?)\s*Pattern:\s*(\d{3})\s*Color:\s*(\d{3})', x)
    out = []
    for stem, (name, pattern, color) in zip(imgs, labels):
        assert stem.endswith(color), f'{stem} does not match colour {color}'
        out.append({'name': name.strip(), 'pattern': pattern, 'color': color,
                    'stem': stem, 'in_stock': None})
    return out


# every archived capture of the Light Jungle Collection, oldest first:
# (snapshot file, wayback timestamp, original url, parser)
JUNGLE_CAPTURES = [
    ('b2b_JungleLight_20010527.html', '20010527044853',
     'http://www.ultrasuede.com/b2b/JungleLight.html', parse_jungle_2001),
    ('light_jungle_fashion_20050211.html', '20050211162424',
     'http://www.ultrasuede.com/products/fashion/swatches/light_jungle.html',
     None),
    ('light_jungle_20050413.html', '20050413075915', None, None),
    ('light_jungle_20050906.html', '20050906010808', None, None),
    ('light_jungle_20061109.html', '20061109202408', None, None),
    ('light_jungle_20070105.html', '20070105080109', None, None),
    ('light_jungle_20081006.html', '20081006041048', None, None),
    ('light_jungle_20090411.html', '20090411232101', None, None),
]
JUNGLE_URL = 'http://www.ultrasuede.com/products/swatches/light_jungle.html'
# Toray's swatch photographs survive for 15 of the 17 patterns. The Wayback
# Machine holds no bobca231.jpg and no ocelo154.jpg — not under the jungle
# directory, not under the 2001 b2b or 2005 fashion paths — so for Bobcat 231
# and Ocelot 154 there is no archived image and never will be. A file placed at
# either name is a stand-in someone supplied by hand: it is carried, because a
# printed pattern cannot be drawn from a hex, but it is labelled
# `reference_photo` rather than `wayback` and it is not evidence of anything.
JUNGLE_UNARCHIVED = {'bobca231', 'ocelo154'}
# Except that one of the two turned out not to need a stand-in. Field's Fabrics
# still serve a flatbed scan of the print at
# assets/images/ultrasuede/177-231.jpg — the pattern's own number, in the folder
# their Ultrasuede swatches live in — and their scan of 177-023 beside it is
# what identifies the drawing: the two show the same large solid rounded spots,
# against the open rosettes of Jaguar 176 and Baby Cougar 181, at the same
# coarser magnification Field's scanned everything at. So it is a photograph of
# the colourway, `fields_live` rather than `reference_photo`, and it is the file
# scraping/fetch_live_swatches.py writes there.
#
# It is still not read for ink. Field's dropped their logo across the middle of
# the scan, which clusters as a third ink that no other 231 print has, and the
# scan is a different generation of photography from Toray's captures — its tan
# reads #c68f4c where Toray's two read #b48e52 and #b89153. Mixing it into the
# median would move Jaguar's and Baby Cougar's published hexes to no better end.
# The picture is Field's; the numbers stay Toray's.
JUNGLE_FIELDS_SCAN = {'bobca231'}


# ------------------------------------------------- Light Jungle colourways ---
#
# Toray's own page gives a pattern number and a colour number and nothing else:
# "Pattern: 181  Color: 023". The colour number is not a pattern's private
# serial — it is the ink combination the print was run in, and it repeats
# across patterns. 023 is on six of the seventeen, 231 on three; a pattern sold
# in two colourways is the same drawing run twice in two sets of inks.
#
# Toray never published what those sets were, but their retailer did. Field's
# Fabrics sold the collection for a decade and printed the combination beside
# the number in their own catalogues — "#176-023 Jaguar - Cream/Black",
# "#173-232-58 Small Pony Cream/Brown", "176-231-58 Jaguar Tan/Black" — and
# they did it consistently: 023 is Cream/Black under four different pattern
# numbers across nine catalogue issues, which is the number meaning the
# combination rather than the print.
#
# That covers three of the ten colourways. The other seven were never named in
# anything archived here, so their names are read off the swatch photographs
# and marked `estimated` — see COLORWAY_ESTIMATED.

COLORWAY_NAME_DIRS = (
    ('fields_catalogs', 'fields-ultrasuede-catalogs'),
    ('fields_sample_sets', 'fields-sample-set-catalogs'),
)
# the vocabulary Field's actually used on these lines, plus how they abbreviate
COLORWAY_WORD = r'(?:Cream|Tan|Brown|Black|Blk\.?|Ivory|White|Beige|Gold)'
COLORWAY_ALIAS = {'Blk': 'Black'}
# `[^#\d]` keeps the match inside one catalogue entry: the lines run together
# once the PDF is flattened to text, and without it #143-210 Leopard would take
# the Cream/Black off the #173-023 Small Pony printed after it.
COLORWAY_RE = re.compile(
    r'#?(\d{2,3})-(\d{3})(?:-\d{2})?\b[^#\d]{0,40}?'
    rf'({COLORWAY_WORD})\s*/\s*({COLORWAY_WORD})', re.I)

# The seven colourways no archived listing ever names, named here from the
# photographs — the same reading the hexes come from, put into words. These are
# descriptions, not Toray's or Field's names for them, and every entry built
# from this table is marked name_source: estimated.
COLORWAY_ESTIMATED = {
    '017': ('Cream', 'Taupe'),
    '154': ('Tan', 'Rust', 'Black'),
    '210': ('Cream', 'Tan', 'Black'),
    '227': ('Beige', 'Brown'),
    '228': ('Gold', 'Black'),
    '229': ('Gold', 'Brown'),
    '241': ('Mauve', 'Charcoal'),
}


def colorway_names():
    """{colour number: (names, source ids, [(pattern, colour), ...])}, from Field's.

    Read out of the extracted catalogue text under research/ rather than out of
    anything this file already holds, so the names are evidence and not a
    transcription. A colour number named two different ways would be a
    contradiction in the record and is raised rather than resolved.
    """
    found = {}
    for folder, source in COLORWAY_NAME_DIRS:
        for path in sorted(glob.glob(os.path.join(RESEARCH, folder, '*.txt'))):
            text = ' '.join(open(path, encoding='utf-8',
                                 errors='replace').read().split())
            for m in COLORWAY_RE.finditer(text):
                pattern, color = m.group(1).zfill(3), m.group(2)
                names = tuple(COLORWAY_ALIAS.get(n, n) for n in
                              (m.group(3).title().rstrip('.'),
                               m.group(4).title().rstrip('.')))
                e = found.setdefault(color, {'names': names, 'sources': set(),
                                             'seen_on': set()})
                assert e['names'] == names, \
                    f'{color} named {e["names"]} and {names}'
                e['sources'].add(source)
                e['seen_on'].add((pattern, color))
    return found


def card_codes(pdf_path, codes):
    """Which of `codes` appear on a colour-card PDF."""
    from extract_pdf_colors import raw_text
    t = raw_text(pdf_path)
    return {c for c in codes if re.search(rf'{c}\s*[A-Z]', t)}


# ------------------------------------------------- Field's Fabrics (custom) ---
#
# Field's Fabrics is a US retailer that had Toray dye LT in colours that were
# never part of the official line. Their own product copy is what marks those:
# "Premium Color only Available at Field's Fabrics". That phrase is necessary
# but NOT sufficient — Field's also applies it to three genuine Toray colours
# (Petit Pois, Opal, Atlantis), so a colour only counts as custom if it is also
# absent from the official 36.

FIELDS = 'https://shop.fieldsfabrics.com'
FIELDS_CUSTOM_URL = f'{FIELDS}/ultrasuede-lt-custom'
FIELDS_LT_URL = f'{FIELDS}/ultrasuede-lt'
EXCLUSIVE_RE = re.compile(
    r"(?i)(premium|custom)\s+colou?r\s+only\s+available\s+at\s+Field'?s\s+Fabrics")
GONE_RE = re.compile(r'(?i)sold[\s-]*out|discontinued')
# suffixes Field's appends to a colour name in product titles
# the only two Field's swatch photos the archive holds, as HHMMSS suffixes
FIELDS_THUMB_TS = {'1419': '110844', '6588': '114343'}
# Field's serves swatch photos out of assets/images/ultrasuede/ for twelve of
# the thirteen and out of assets/images/ for Orquidea, whose product page is
# the only one linking the shorter path. Codes listed here take that path;
# everything else takes the usual one. Recorded rather than probed, because
# this script does no network access.
FIELDS_IMG_FLAT = {'9437'}
# LT Blue is older than the rest of Field's Ultrasuede photography and sits
# under its own filename rather than the code, so its path is given outright.
FIELDS_IMG_PATH = {'100': 'assets/images/100lightblue.jpg'}
# It is also the one Field's photograph with no watermark across the middle of
# it — a 300px frame from 2012, where the rest are 600px and stamped — so it is
# sampled from a centre crop like the Toray swatches instead of from the corners.
FIELDS_IMG_UNMARKED = {'100'}
# Codes kept in the file but not drawn on the page, with the reason. The record
# is the point of this dataset, so nothing is deleted to take it off the page —
# an entry listed here keeps everything it has and is skipped by the renderer.
OFF_PAGE = {
    '100': "kept in the record but not shown: Field's is the only source for "
           "it, the photograph is theirs rather than a swatch capture, and the "
           "colour is close enough to #2424 Lt. Blue that showing both invites "
           "the reader to read a difference into two photographs taken sixteen "
           "years apart",
}
NAME_TRIM_RE = re.compile(
    r'(?i)\s*-*\s*(fabric by the yard|(premium|custom) colou?r|58"? wide|extrawide'
    r'|\d+ ?/ ?\d+ yd minimum|new|30% plant based)\s*$')


def fields_label_name(text, code):
    """Pull a colour name out of a Field's product title or listing label."""
    tail = re.split(rf'\b{code}\b', text, maxsplit=1)[-1]
    tail = tail.replace('-', ' ').replace('_p ', ' ')
    tail = re.sub(r'(?i)\.html.*$', '', tail).strip(' -–—')
    prev = None
    while tail != prev:
        prev, tail = tail, NAME_TRIM_RE.sub('', tail).strip(' -–—')
    return re.sub(r'\s+', ' ', tail).strip()


def parse_fields_listing(path):
    """Parse a Field's category page into {code: label}.

    Labels matter as much as codes: the "(Sold Out - Discontinued)" prefix in a
    listing is how a colour's last *offered* date is told apart from the last
    date its page merely still existed.
    """
    t = open(path, encoding='utf-8', errors='replace').read()
    out = {}
    for m in re.finditer(r'(?i)<a[^>]+href="[^"]*_p_(\d+)\.html"[^>]*>(.*?)</a>',
                         t, re.S):
        label = re.sub(r'\s+', ' ',
                       html.unescape(re.sub(r'<[^>]+>', ' ', m.group(2)))).strip()
        if not label or not re.search(r'(?i)\bLT\b', label):
            continue
        code = re.search(r'#?\s*(\d{4})\s+[A-Z]', label)
        if code:
            out[code.group(1)] = {'label': label, 'product_id': m.group(1)}
    return out


def fields_product_captures(pid):
    """Capture history of one Field's product page, from its saved CDX response.

    Returns [{ts, url, title, gone}], oldest first, 200s only.
    """
    path = os.path.join(HERE, 'cdx_fields', f'p_{pid}.json')
    rows = json.load(open(path))[1:]
    out = []
    for ts, url, status in rows:
        title = unquote(url).rsplit('/', 1)[-1]
        title = re.sub(r'_p_\d+\.html.*$', '', title).replace('-', ' ')
        out.append({'ts': ts, 'url': url, 'status': status, 'title': title.strip(),
                    'gone': bool(GONE_RE.search(title))})
    out.sort(key=lambda c: c['ts'])
    # dedupe identical timestamps (the CDX index lists some captures twice)
    seen, uniq = set(), []
    for c in out:
        if c['ts'] in seen:
            continue
        seen.add(c['ts'])
        uniq.append(c)
    return uniq


# ------------------------------------------- Field's pre-2011 Light record ---
#
# Field's Fabrics sold Ultrasuede Light for a decade before Toray's own swatch
# site went up, in a range far wider than the 36 that site ever listed. Their
# 2001 b2b copy advertises "40 high-fashion colors" against the 36 the archive
# can name, and this is where the rest of them went: 69 more colour names, off
# three of Field's own list pages and nine issues of their printed Ultrasuede
# catalogue, 2002-08 → 2010-03. Everything read here is saved under research/.
#
# These entries are names, numbers and dates and nothing else. No swatch
# photograph of any of them survives — of the 41 thumbnail URLs the Wayback
# index holds for that shop, 39 answer 404 from a 2018 crawl of a site that was
# already gone — so there is no hex, and nothing for the shader to draw. That is
# why they are kept apart from colors: rather than folded into it. What is known
# about one of these is that it existed, was called this, and was sold at this
# width.
#
# Two of the four names this hunt set out to find are in here: #4599 Active
# Green and #8281 Orange Sherbet. Both are separated from their same-named Soft
# counterpart (#4598, #8280) by appearing in a different section of the same
# catalogue sheet, which is what makes them Light rather than a transcription
# slip.

RESEARCH = os.path.join(ROOT, 'research')
HISTORICAL_JSON = os.path.join(RESEARCH, 'new_light_colors.json')
# scans of the pre-2011 colours, recovered from Field's own /swatches/ folder:
# research/old_swatch_images.json says which capture each one came from, and
# scraping/crop_old_swatches.py has already cut the scanner paper off them.
OLD_SWATCH_JSON = os.path.join(RESEARCH, 'old_swatch_images.json')
OLD_SWATCH_DIR = 'images/fields_old'
OLD_SWATCH_THUMBS = os.path.join(RESEARCH, 'swatches_cropped')
# the pictures no archive kept, taken off Field's live site instead:
# research/live_swatch_images.json says where each came from, and
# scraping/fetch_live_swatches.py explains what is and is not taken from there.
# Some are filed under the number the same colour carries in another weight, and
# say so in `based_on` — that is a stand-in, and the page labels it as one.
LIVE_SWATCH_JSON = os.path.join(RESEARCH, 'live_swatch_images.json')
# the three list pages, by the filename prefix each capture is saved under
OLD_PAGES = {
    'lgtlist': 'Light 45" list',
    'wide_list': 'Light Extrawide 58" list',
    'spec_list': 'Specials list',
}
# widths the list pages establish; a colour seen only in a catalogue gets none,
# because the catalogue's own section headings are not recorded per entry.
OLD_PAGE_WIDTH = {'lgtlist': '45"', 'wide_list': '58" Extrawide'}
# each issue of Field's printed catalogue, as the Wayback capture of the PDF
FIELDS_CATALOGS = {
    '2005-03': ('20050529203332',
                'http://www.fieldsfabrics.com:80/ultra_list_0305.pdf'),
    '2005-08': ('20051016193910',
                'http://www.fieldsfabrics.com:80/ultra_list_0805.pdf'),
    '2005-12': ('20060228111950',
                'http://www.fieldsfabrics.com:80/ultra_list_1205.pdf'),
    '2006-03': ('20060818085820',
                'http://www.fieldsfabrics.com:80/ultra_list_0306.pdf'),
    '2006-08': ('20061017203815',
                'http://www.fieldsfabrics.com/ultra_list_0806.pdf'),
    '2007-01': ('20070315212644',
                'http://fieldsfabrics.com:80/ultra_list_0107.pdf'),
    '2008-03': ('20080516075458',
                'http://www.fieldsfabrics.com/ultra_list_0308.pdf'),
    '2008-08': ('20081031060233',
                'http://www.fieldsfabrics.com:80/ultra_list_0808.pdf'),
    '2010-02': ('20100331191404',
                'http://www.fieldsfabrics.com:80/ultra_list_0210.pdf'),
}


def old_page_index():
    """{(page, timestamp): original_url} for every list-page capture saved.

    The URL matters because Field's moved these pages twice — /shopping/ultra/
    early on, /ultra/ later, with and without the www — so a capture cannot be
    linked back to the archive without knowing which of them it was taken from.
    """
    idx = {}
    for page in OLD_PAGES:
        path = os.path.join(RESEARCH, 'cdx', f'cdx_page_{page}.json')
        for url, ts, _status in json.load(open(path))[1:]:
            idx[(page, ts)] = url
    return idx


# stock notes Field's appended to a colour's name in a list, which are not part
# of the name: "Aqua - Sold Out", "Cameo on back order".
STOCK_NOTE_RE = re.compile(
    r'(?i)\s*[-–—,]?\s*\b(sold\s*out|on\s+back\s*order|back\s*ordered?'
    r'|discontinued|special\s+order|new)\b\s*$')


def historical_name(variants):
    """One display name out of the ways Field's printed a colour.

    Stock notes come off first, and what is left is taken at its longest rather
    than its shortest: the variants that differ do so by carrying a qualifier —
    #5837 is "White" on one line and "White - Extra-supple" on another — and the
    qualifier is the entire reason that entry is not the White in colors:.
    """
    cleaned = set()
    for v in variants:
        prev = None
        while v != prev:
            prev, v = v, STOCK_NOTE_RE.sub('', v).strip(' -–—,')
        v = re.sub(r'\s+', ' ', v).strip()
        if v:
            cleaned.add(v)
    return max(sorted(cleaned), key=len) if cleaned else variants[0]


# Two names land twice, once on the old lists and once on the shop that replaced
# them, under numbers that do not match. Each number is printed consistently
# throughout its own era and nothing in the record says whether a colour was
# renumbered or two colours were simply given one name, so neither is corrected
# and the pair point at each other instead.
#
# Recovering the old scans settled one of them and not the other, which is why
# the notes read differently: #2894 Imperial Blue is a pale periwinkle and the
# shop's #2694 is a deep navy, so those are two colours; the two Light Blues are
# close enough that the photography could account for the gap.
HISTORICAL_SEE_ALSO = {
    '2894': {
        'code': '2694',
        'note': "the same name on Field's later shop, under a different number "
                '— but the scan of this one is a pale periwinkle and #2694 is a '
                'deep navy, so the name is shared and the colour is not',
        'back': "the same name on Field's pre-2011 lists, under a different "
                'number — but the scan of that one is a pale periwinkle and '
                'this is a deep navy, so the name is shared and the colour is '
                'not',
    },
    '2424': {
        'code': '100',
        'note': "near enough the same name on Field's later shop, under a "
                'different number; the two greys are close, and a flatbed scan '
                'and a product photograph sixteen years apart could account for '
                'the difference either way',
        'back': "near enough the same name on Field's pre-2011 lists, under a "
                'different number; the two greys are close, and a flatbed scan '
                'and a product photograph sixteen years apart could account for '
                'the difference either way',
    },
}


def historical_colors(colors):
    """The pre-2011 Light colours Toray's own record never held.

    A colour is excluded if the official 36 already account for it under any
    number they ever carried: White is in the raw list as #5832, which is not a
    separate colour but White's own pre-2010 SKU.
    """
    known = {c['code'] for c in colors}
    for c in colors:
        known |= {f['code'] for f in c.get('former_skus', [])}

    pages = old_page_index()
    scans = json.load(open(OLD_SWATCH_JSON))
    shots = json.load(open(LIVE_SWATCH_JSON))
    saved = {}
    for path in glob.glob(os.path.join(RESEARCH, 'fields_oldsite', '*.html')):
        m = re.match(r'(lgtlist|wide_list|spec_list)_(\d{14})\.html',
                     os.path.basename(path))
        if m:
            saved.setdefault(m.group(2), []).append(m.group(1))

    out = []
    for code, rec in json.load(open(HISTORICAL_JSON)).items():
        if code in known:
            continue
        seen, widths = [], set()
        for cap in sorted(rec['captures']):
            if cap.startswith('cat'):
                issue = cap[3:]
                ts, url = FIELDS_CATALOGS[issue]
                seen.append({'date': issue, 'in': "Field's Ultrasuede catalogue",
                             'archive_url': f'{WAYBACK}/{ts}/{url}'})
                continue
            for page in sorted(saved.get(cap, [])):
                if page in OLD_PAGE_WIDTH:
                    widths.add(OLD_PAGE_WIDTH[page])
                seen.append({'date': iso(cap), 'in': OLD_PAGES[page],
                             'archive_url': f'{WAYBACK}/{cap}/{pages[(page, cap)]}'})
        seen.sort(key=lambda s: s['date'])
        name = historical_name(rec['name_variants'])
        scan = scans.get(code)
        # the archive first: a capture of the page that sold the colour is a
        # better provenance than a file still sitting on a shop's server, and
        # only a colour with neither is left with nothing to show.
        shot = shots.get(code) if not scan else None
        # `frame` is whether path is a full-size photograph rather than a
        # thumbnail, which is what decides how the nap is read further down
        rgb, path, image, frame = None, None, None, False
        if scan:
            full = frame = scan['size'] == 'full'
            # both sizes are published; a thumbnail is read from the research
            # copy rather than the squared one beside the full scans, so that
            # squaring a photograph for the page can never move a colour
            image = f'{OLD_SWATCH_DIR}/{code}.jpg'
            path = os.path.join(ROOT, image) if full else \
                os.path.join(OLD_SWATCH_THUMBS, f'{code}.jpg')
            # a thumbnail is ~57px square once the paper is off it, so it is
            # read with wider boxes pulled closer to the edge, and its nap is
            # left entirely to the model: an axis regressed over three thousand
            # pixels of a hundred-pixel JPEG is measuring the encoder.
            rgb = (sample_color_corners(path) if full
                   else sample_color_corners(path, inset=0.04, size=0.30))
        elif shot:
            image = shot['image']
            path = os.path.join(ROOT, image)
            frame = True
            # watermarked across the middle like the rest of Field's
            # photography, so read from the four corners the same way
            rgb = sample_color_corners(path)
        out.append({
            'name': name,
            'slug': slugify(name),
            'code': code,
            'sku': None,        # Toray never gave these an 8801- SKU either
            'hex': hexstr(rgb) if rgb else None,
            'rgb': rgb,
            # a thumbnail's nap is still left entirely to the model even though
            # its photograph is now shown: publishing a 57px frame says the
            # cloth looked like this, measuring an axis off it would be
            # claiming to know its grain, and that is the encoder talking.
            'nap': nap(path if frame else None, rgb, corners=True),
            'image': image,
            'image_source': (scan['archive_url'] if scan else
                             shot['source'] if shot else None),
            'image_provenance': (None if not (scan or shot) else
                                 'live_site' if shot else
                                 'archived_scan' if scan['size'] == 'full'
                                 else 'archived_thumbnail'),
            # names are transcribed as printed, Field's own typos included
            # ("Eclispe", "Bourdeax"), so a colour listed two ways keeps both.
            'name_variants': rec['name_variants'],
            'widths': sorted(widths),
            'years': rec['years'],
            'first_seen': min(rec['years']),
            'last_seen': max(rec['years']),
            'evidence': sorted({OLD_PAGES[p] for c in rec['captures']
                                for p in saved.get(c, [])} |
                               {"Field's Ultrasuede catalogue"
                                for c in rec['captures'] if c.startswith('cat')}),
            'source': seen[-1]['archive_url'] if seen else None,
            'captures': seen,
            'sources': ['fields-old-light-lists'] +
                       (['fields-ultrasuede-catalogs']
                        if any(c.startswith('cat') for c in rec['captures'])
                        else []),
        })
        if shot and shot.get('weight'):
            # The picture is of the same colour in a different cloth, because
            # nothing ever photographed the Light one. Everything needed to say
            # so on the page and to check the claim is kept here: the weight,
            # the number the colour carries there, and the sheet that prints the
            # two numbers together.
            out[-1]['based_on'] = {
                'weight': shot['weight'],
                'code': shot['code'],
                'evidence': shot['evidence'],
            }
        if code in HISTORICAL_SEE_ALSO:
            ref = HISTORICAL_SEE_ALSO[code]
            # `set` is filled in once the two sets are settled — see main().
            out[-1]['see_also'] = {'code': ref['code'], 'set': None,
                                   'note': ref['note']}
    return sorted(out, key=lambda e: e['name'].lower())


# ------------------------------------------------------------- colour math ---

def sample_color(path):
    """Representative colour of a swatch photo.

    Suede has a directional nap, so the median of a centre crop is far more
    stable than the mean of the whole frame (which picks up edge vignetting).
    """
    im = Image.open(path).convert('RGB')
    w, h = im.size
    m = 0.2
    im = im.crop((int(w * m), int(h * m), int(w * (1 - m)), int(h * (1 - m))))
    a = np.asarray(im).reshape(-1, 3)
    med = np.median(a, axis=0).round().astype(int)
    return [int(v) for v in med]


def sample_color_corners(path, inset=0.06, size=0.16):
    """Representative colour, sampled from four corner patches.

    Field's product photos carry a white "Field's FABRICS" watermark across the
    middle of the swatch. The median mostly shrugs thin white text off, but
    reading the corners instead keeps the watermark out of the sample entirely.
    """
    im = Image.open(path).convert('RGB')
    w, h = im.size
    iw, ih, sw, sh = int(w * inset), int(h * inset), int(w * size), int(h * size)
    boxes = [(iw, ih, iw + sw, ih + sh), (w - iw - sw, ih, w - iw, ih + sh),
             (iw, h - ih - sh, iw + sw, h - ih),
             (w - iw - sw, h - ih - sh, w - iw, h - ih)]
    a = np.concatenate([np.asarray(im.crop(b)).reshape(-1, 3) for b in boxes])
    med = np.median(a, axis=0).round().astype(int)
    return [int(v) for v in med]


# ----------------------------------------------------------------- ink math ---
#
# A printed swatch is not one colour, so a Jungle print gets a small palette
# instead of a hex: the two or three inks the pattern was run in.
#
# Reading them is k-means in CIELAB, with two problems to get past. The first
# is that a cluster's mean is not its ink: every boundary in the print is a
# smear of the two colours either side of it, and those blend pixels drag a
# mean off the ink and towards the middle of the swatch. So a cluster reports
# the median of its *core* — its mask eroded by a pixel or two, which is what
# survives of a region once its own boundary is cut away.
#
# The second is knowing how many inks there are, and erosion answers that too.
# Ask for one cluster more than the print has and k-means does not invent an
# ink; it splits the blend shell off as a cluster of its own. That cluster has
# no core: it is a one- or two-pixel outline around everything, and erosion
# empties it. Every real ink here keeps 10–87% of its pixels under the same
# erosion, and every spurious one keeps 0–3%, which is not a threshold that
# needs to be chosen carefully. So k rises while every cluster still has a core
# and no two clusters land on the same colour, and stops when one does not.
#
# It settles at two inks for fourteen of the fifteen photographed prints and at
# three for Leopard 210 and Ocelot 154, which is what the eye reads off them:
# leopard rosettes are a tan fill inside a black outline on cream, and every
# other print here is a mark in one ink on a ground in another.

INK_BLUR = 0.8              # JPEG grain, not print edges
INK_ERODE = 3               # MinFilter window, px; 5 on a photograph over 300px
INK_ERODE_LARGE = 5
INK_LARGE = 300
INK_CORE_MIN = 0.08         # a real ink keeps ≥10% of itself; a blend shell ≤3%
INK_SEPARATION = 12.0       # ΔE below which two clusters are one ink
INK_MAX = 6
INK_SAMPLE = 12000          # pixels the centroids are fitted on
INK_SEED = 0

_LAB_D = 6 / 29
_XYZ = np.array([[0.4124, 0.3576, 0.1805],
                 [0.2126, 0.7152, 0.0722],
                 [0.0193, 0.1192, 0.9505]])
_WHITE = np.array([0.95047, 1.0, 1.08883])


def to_lab(rgb):
    """sRGB 0–255 → CIELAB, over an array of any shape ending in 3."""
    a = np.asarray(rgb, float) / 255.0
    a = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    t = (a @ _XYZ.T) / _WHITE
    f = np.where(t > _LAB_D ** 3, np.cbrt(t), t / (3 * _LAB_D ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16,
                     500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], -1)


def _kmeans(x, k, iters=80):
    """Plain k-means with k-means++ seeding, on a fixed seed so builds repeat."""
    rng = np.random.default_rng(INK_SEED)
    centers = [x[rng.integers(len(x))]]
    for _ in range(k - 1):
        d = np.min(((x[:, None] - np.array(centers)[None]) ** 2).sum(-1), 1)
        centers.append(x[rng.choice(len(x), p=d / d.sum())])
    c = np.array(centers)
    for _ in range(iters):
        lab = np.argmin(((x[:, None] - c[None]) ** 2).sum(-1), 1)
        moved = np.array([x[lab == i].mean(0) if (lab == i).any() else c[i]
                          for i in range(k)])
        if np.allclose(moved, c):
            break
        c = moved
    return c


def ink_clusters(path, k):
    """`k` clusters of a print photograph, lightest first.

    Each carries the median of its eroded core, the share of the frame it
    covers, and how much of it survived the erosion.
    """
    im = Image.open(path).convert('RGB')
    erode = INK_ERODE_LARGE if max(im.size) > INK_LARGE else INK_ERODE
    smooth = np.asarray(im.filter(ImageFilter.GaussianBlur(INK_BLUR)), float)
    h, w, _ = smooth.shape
    lab = to_lab(smooth.reshape(-1, 3))
    raw = np.asarray(im, float).reshape(-1, 3)

    rng = np.random.default_rng(INK_SEED)
    fit = lab[rng.choice(len(lab), min(INK_SAMPLE, len(lab)), replace=False)]
    centers = _kmeans(fit, k)
    which = np.argmin(((lab[:, None] - centers[None]) ** 2).sum(-1), 1)

    out = []
    for i in range(k):
        mask = (which == i).reshape(h, w)
        n = int(mask.sum())
        if not n:
            return None
        core = np.asarray(Image.fromarray((mask * 255).astype(np.uint8))
                          .filter(ImageFilter.MinFilter(erode))) > 127
        # a core too small to take a median off falls back to the whole
        # cluster, which then fails the core test below anyway
        picked = core.reshape(-1) if core.sum() >= 40 else mask.reshape(-1)
        rgb = np.median(raw[picked], axis=0).round().astype(int)
        out.append({'rgb': [int(v) for v in rgb], 'lab': to_lab(rgb),
                    'share': n / (h * w), 'core': core.sum() / n})
    return sorted(out, key=lambda c: -c['lab'][0])


def print_inks(path):
    """The inks a printed swatch was run in, lightest first."""
    def solid(clusters):
        if clusters is None or any(c['core'] < INK_CORE_MIN for c in clusters):
            return False
        return all(np.linalg.norm(a['lab'] - b['lab']) >= INK_SEPARATION
                   for i, a in enumerate(clusters) for b in clusters[i + 1:])

    best = ink_clusters(path, 2)
    assert solid(best), f'{path}: not even two inks read cleanly'
    for k in range(3, INK_MAX + 1):
        more = ink_clusters(path, k)
        if not solid(more):
            break
        best = more
    return best


# ---------------------------------------------------------------- nap math ---
#
# The site draws each swatch with a shader instead of the photograph, so the
# photographs have to give up two more numbers than a single hex: which way the
# nap's light-and-dark variation runs through RGB, and how strong it is.
#
# What the photographs actually show, measured across all 30 large captures:
#
#   * The variation is very nearly *additive and achromatic* — the 2nd and 98th
#     luminance percentiles of a swatch sit on either side of the median at the
#     same distance in all three channels, so a nap highlight is the base colour
#     plus a constant, not the base colour scaled. A handful of swatches do lean
#     (Opal's highlights run blue, Blackberry's run red), which is what `axis`
#     is for.
#   * Most of what a naive measurement calls "texture" is not texture at all.
#     Decomposed into Gaussian octaves, 80% of a swatch's variance sits in the
#     finest, pixel-scale band — but that band's lag-1 autocorrelation is
#     *negative* horizontally (−0.10) and only 0.21 vertically, which is the
#     signature of sensor and JPEG noise, not of a physical surface. Every band
#     from 2px up is positively correlated (0.53 rising to 0.99) and reads as
#     real structure. So the finest band is blurred away before anything is
#     measured, and the shader does not reproduce it: drawing a camera's noise
#     budget as a coherent noise field is what made the nap read as sharp
#     directional streaks rather than as cloth.
#   * What is left is much broader and much gentler. Of the structural
#     variation, 45% is a fine mottle around 100 cycles across the frame and
#     36% is broad cloud — slower than 3 cycles — with a thin tail between.
#     NAP_WEIGHTS is that spectrum. Total structural contrast runs 1.5 to 4.9
#     across the 30 large captures, against the 2.4-to-12.2 the old measurement
#     reported when the noise band was counted as fabric.
#   * The broad cloud is deliberately kept even though some of it is the
#     photographer's lighting falloff rather than the cloth. The two cannot be
#     separated at this frame size, and it is the single component that most
#     makes a swatch read as a photograph of a material.
#   * Once measured this way the structural bands are isotropic — vertical and
#     horizontal correlation agree to within 2–5% — so the nap gets no
#     directional stretch. The 19% anisotropy an earlier pass found was a
#     property of the noise band, i.e. of JPEG, not of the nap.
#   * Contrast is not free: it rises with the swatch's own lightness and falls
#     away again near white, because the fabric modulates reflectance by a ratio
#     while the photograph records it through a gamma curve. NAP_FIT is that
#     curve, and it accounts for 70% of the spread.

NAP_NOISE = 1.0                       # blurred away first: the camera's, not the cloth's
NAP_RADII = (2.0, 5.0, 12.0, 30.0)    # Gaussian split points, px of a 400px frame
NAP_FRAME = 400
# per-octave share, unit-normalised; the fifth is everything broader than the
# last split point, which is where the cloudiness lives.
NAP_WEIGHTS = [0.6734, 0.3242, 0.2181, 0.1967, 0.5959]
NAP_FIT = (8.02, 0.65, 0.50)          # contrast = A·x^p·(1−x)^q for x = L/255
# The lightness range the fit actually rests on: the darkest and lightest of the
# 30 measured captures, Noir at L = 25.1 and Country Cream at L = 240.7. Beyond
# either end the curve is extrapolation, and below the dark end that is not a
# small thing — x^0.65 goes on falling toward zero, and there is nothing down
# there to say it should. Only two captures anchor that end at all, and at the
# darker of them the curve reads 1.73 against a measured 1.51, so it is not even
# holding its shape by the last point it has.
#
# Burgundy is the one colour this reaches: L = 18.9, and a 100px photograph, so
# it is modelled rather than measured. Run past the edge the curve calls it
# 1.42, which draws a swatch with no visible nap at all; held at the edge it is
# 1.69. Nothing else in the set sits outside the range, at either end, so the
# clamp moves that one number and no others.
NAP_FIT_SUPPORT = (25.07 / 255, 240.69 / 255)
LUMA = np.array([0.2126, 0.7152, 0.0722])
# below this much structural variation an image is too small or too compressed
# to read a colour direction off, and the axis falls back to neutral.
NAP_AXIS_FLOOR = 1.2
# a full-frame photograph narrower than this cannot resolve the octaves, so its
# contrast is modelled from NAP_FIT rather than measured.
NAP_MEASURABLE = 300


def nap_blur(im):
    """The image with its pixel-noise band taken off — see the note above."""
    return im.filter(ImageFilter.GaussianBlur(NAP_NOISE))


def nap_contrast_model(rgb):
    """Modelled nap contrast for a colour, in 0–255 luminance units.

    Evaluated on lightness clamped to NAP_FIT_SUPPORT, so the curve is read
    where it was fitted and held flat beyond that rather than extrapolated.
    """
    a, p, q = NAP_FIT
    lo, hi = NAP_FIT_SUPPORT
    x = min(max(float(np.asarray(rgb) @ LUMA) / 255.0, lo), hi)
    return a * x ** p * (1 - x) ** q


def nap_axis(patches):
    """Direction the nap's light-and-dark variation takes through RGB.

    Regresses each channel against luminance over the sampled pixels, then
    scales the result so its own luminance is exactly 1 — which leaves the
    contrast figure meaning "standard deviation of luminance" and the axis
    meaning "and here is how that luminance splits across the channels".

    The patches arrive already de-noised, and it matters: camera noise is very
    nearly neutral, so regressing over raw pixels drags every axis toward
    [1,1,1]. Opal's blue lean reads 1.36 through the noise and 1.59 without it.
    """
    px = np.concatenate([p.reshape(-1, 3) for p in patches]).astype(np.float64)
    lc = px @ LUMA
    lc -= lc.mean()
    denom = float(lc @ lc)
    spread = float(np.sqrt(denom / len(lc)))
    if denom == 0 or spread < NAP_AXIS_FLOOR:
        return [1.0, 1.0, 1.0]
    axis = np.array([float(lc @ (px[:, i] - px[:, i].mean())) / denom
                     for i in range(3)])
    return [round(float(v), 4) for v in axis / float(axis @ LUMA)]


def nap_contrast(path):
    """Measured nap contrast, or None if the photo is too small to hold it.

    Takes the pixel-noise band off, splits what is left into the four NAP_RADII
    octaves plus everything broader than the last, and adds their variances —
    the same five bands NAP_WEIGHTS describes, so the figure the shader is
    handed is the standard deviation of exactly what the shader draws.
    """
    im = Image.open(path)
    if min(im.size) < NAP_MEASURABLE:
        return None
    frame = nap_blur(im.convert('RGB').resize((NAP_FRAME, NAP_FRAME),
                                              Image.LANCZOS))
    m = NAP_FRAME // 16          # keep the frame edge out of the statistics
    var, prev = 0.0, np.asarray(frame).astype(np.float64)
    for r in NAP_RADII:
        blur = np.asarray(
            Image.fromarray(prev.round().clip(0, 255).astype(np.uint8))
            .filter(ImageFilter.GaussianBlur(r))).astype(np.float64)
        var += float(((prev - blur) @ LUMA)[m:-m, m:-m].var())
        prev = blur
    var += float((prev @ LUMA)[m:-m, m:-m].var())   # the broad cloud
    return float(np.sqrt(var))


# --------------------------------------------------- small-frame contrast ---
#
# NAP_MEASURABLE refuses to measure a frame under 300px, on the reasoning that
# the fine octaves are not there to be found. Measured, that is too cautious.
#
# Taking LX's 21 photographs that are 800px or larger, downsampling each to a
# given edge and re-measuring, against the same photograph at native size:
#
#     edge    median ratio   spread        stdev
#     256px   0.993          0.90 - 1.08   0.031
#     197px   0.951          0.83 - 1.08   0.049
#      93px   0.800          0.58 - 0.87   0.096
#
# So a 256px frame loses essentially nothing, a 197px frame loses 5%, and a
# 93px frame loses 20% and gets noisy with it. That is a correctable bias
# rather than an absence, which is what lets Lamous (197px) and Shammy (93px)
# carry measured contrast instead of none at all.
#
# The correction is interpolated on the frame's short edge and clamped to the
# ends. Below 93px it is not extrapolated — there is no measurement down there
# and the trend is steepening, so the floor is held and the caller is told.
NAP_RES_CALIBRATION = [(93, 0.800), (197, 0.951), (256, 0.993), (300, 1.0)]


def nap_res_factor(edge):
    """What a frame of this short edge reports, as a fraction of native."""
    pts = NAP_RES_CALIBRATION
    if edge >= pts[-1][0]:
        return 1.0
    if edge <= pts[0][0]:
        return pts[0][1]
    for (e0, f0), (e1, f1) in zip(pts, pts[1:]):
        if e0 <= edge <= e1:
            t = (edge - e0) / (e1 - e0)
            return f0 + t * (f1 - f0)
    return 1.0


def nap_small(path, rgb, corners=False):
    """A `nap` block for a frame too small for the plain measurement.

    Measures anyway, then divides out the resolution bias calibrated above.
    contrast_source records that this happened and what was divided out, so a
    reader can tell these apart from the frames that needed no help.
    """
    im = Image.open(path)
    edge = min(im.size)
    factor = nap_res_factor(edge)
    saved = globals()['NAP_MEASURABLE']
    globals()['NAP_MEASURABLE'] = 1          # we are handling the size question
    try:
        raw = nap_contrast(path)
    finally:
        globals()['NAP_MEASURABLE'] = saved
    if raw is None:
        return None
    block = nap(path, rgb, corners=corners, measure=False)   # axis only
    block['contrast'] = round(raw / factor, 2)
    block['contrast_source'] = 'measured-small-frame'
    block['contrast_frame_px'] = edge
    block['contrast_res_factor'] = round(factor, 3)
    return block


def nap(path, rgb, corners=False, measure=None):
    """The `nap` block for an entry: how to draw it without the photograph."""
    if rgb is None:
        return None
    patches = None
    if path:
        # de-noised before cropping rather than after: a 1px blur run on a
        # corner box would pull the box's own edge into its statistics.
        im = nap_blur(Image.open(path).convert('RGB'))
        w, h = im.size
        if corners:
            # the same four corner boxes sample_color_corners reads, for the
            # same reason: Field's watermark sits across the middle.
            iw, ih, sw, sh = int(w * 0.06), int(h * 0.06), int(w * 0.16), int(h * 0.16)
            boxes = [(iw, ih, iw + sw, ih + sh), (w - iw - sw, ih, w - iw, ih + sh),
                     (iw, h - ih - sh, iw + sw, h - ih),
                     (w - iw - sw, h - ih - sh, w - iw, h - ih)]
        else:
            m = 0.2
            boxes = [(int(w * m), int(h * m), int(w * (1 - m)), int(h * (1 - m)))]
        patches = [np.asarray(im.crop(b)) for b in boxes]

    # Contrast is only measured off a clean full frame. The Field's photographs
    # are shot at a coarser magnification than Toray's, so they take the model —
    # which also keeps all fourteen of them consistent with each other rather
    # than with two different cameras. `measure` says so outright for LT Blue,
    # whose photograph is unwatermarked and so is read from the centre like a
    # Toray one, but is still a Field's photograph and still takes the model:
    # measured off that older, grainier 300px frame it comes out at 6.29, above
    # every Toray colour in the set.
    if measure is None:
        measure = not corners
    measured = nap_contrast(path) if (path and measure) else None
    return {
        'axis': nap_axis(patches) if patches else [1.0, 1.0, 1.0],
        'contrast': round(measured if measured is not None
                          else nap_contrast_model(rgb), 2),
        'contrast_source': 'measured' if measured is not None else 'modeled',
    }


def hexstr(rgb):
    return '#%02x%02x%02x' % tuple(rgb)


def slugify(name):
    s = (name.replace('é', 'e').replace('è', 'e').lower())
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', s)).strip('-')


def number_key(text):
    """Order a colour or pattern number the way it is read rather than the way
    it is spelled: 100 before 1419, and 7369 before 7369S. A plain string sort
    puts LT Blue's 100 after every four-digit code in the line."""
    m = re.match(r'(\d*)(.*)', text or '')
    return (int(m.group(1)) if m.group(1) else -1, m.group(2))


def iso(ts):
    return f'{ts[0:4]}-{ts[4:6]}-{ts[6:8]}'


# ------------------------------------------------------------------- build ---

def main():
    # --- 1. the swatches.ultrasuede.us index captures (2016 -> 2026) ---------
    captures = []
    for path in sorted(glob.glob(os.path.join(HERE, 'snapshots/LT/*.html'))):
        ts = os.path.basename(path)[:-5]
        parsed = parse_lt_index(path)
        assert parsed['declared'] == len(parsed['colors']), \
            f'{ts}: header says {parsed["declared"]}, parsed {len(parsed["colors"])}'
        captures.append({'ts': ts, **parsed})

    populated = [c for c in captures if c['colors']]
    latest = populated[-1]
    codes = sorted(latest['colors'])
    names = {c: latest['colors'][c]['name'] for c in codes}
    style = latest['colors'][codes[0]]['style']

    # every populated capture must show the identical set -- this is the
    # central claim of the dataset, so assert it rather than trusting it.
    for c in populated:
        assert set(c['colors']) == set(codes), f'{c["ts"]} colour set differs'

    # --- 2. historical sources ---------------------------------------------
    h = os.path.join(HERE, 'snapshots/hist')
    s2005 = parse_2005_page(os.path.join(h, 'products_swatches_light.html_20050413075819.html'))
    s2005f = parse_2005_page(os.path.join(h, 'products_fashion_swatches_light.html_20050211161710.html'))
    s2010 = parse_2010_index(os.path.join(h, 'uscom_searchresult_Light_20101201.html'))
    lt2020 = set(re.findall(
        r'lt_(?:l_)?(\d{4})\.jpg',
        open(os.path.join(h, 'uscom_products_lt_20200604.html'),
             encoding='utf-8', errors='replace').read()))

    cards = {
        'colorcard-light-2010': card_codes(
            os.path.join(ROOT, 'colorcards/ultrasuede_light_2010-12-07.pdf'), codes),
        'colorcard-lt-2017': card_codes(
            os.path.join(ROOT, 'colorcards/ultrasuede_lt_2017-05-19.pdf'), codes),
    }

    # 2005 keyed by name, since White was renumbered 5832 -> 5872 afterwards
    by_name_2005 = {n: c for c, n in s2005.items()}

    # --- 3. source registry -------------------------------------------------
    idx_url = 'http://swatches.ultrasuede.us/swatches/search_result.php?product=LT'
    sources = [
        {
            'id': 'swatches-lt',
            'kind': 'swatch_index',
            'title': 'Ultrasuede® Swatches — Search Result: Ultrasuede® LT',
            'site': 'swatches.ultrasuede.us',
            'original_url': idx_url,
            'latest_archive_url': f'{WAYBACK}/{latest["ts"]}/{idx_url}',
            'captures': [
                {'date': iso(c['ts']),
                 'colors_listed': len(c['colors']),
                 'archive_url': f'{WAYBACK}/{c["ts"]}/{idx_url}'}
                for c in captures
            ],
        },
        {
            'id': 'uscom-light-2010',
            'kind': 'swatch_index',
            'title': 'Ultrasuede® Swatches — Search Result: Ultrasuede® Light',
            'site': 'ultrasuede.com',
            'original_url': 'http://www.ultrasuede.com/swatches/search_result.php?product=Light',
            'archive_url': f'{WAYBACK}/20101201185451/http://www.ultrasuede.com/swatches/search_result.php?product=Light',
            'captured': '2010-12-01',
            'colors_listed': len(s2010),
        },
        {
            'id': 'uscom-light-2005',
            'kind': 'swatch_page',
            'title': 'Ultrasuede® light — STYLE #801',
            'site': 'ultrasuede.com',
            'original_url': 'http://www.ultrasuede.com/products/swatches/light.html',
            'archive_url': f'{WAYBACK}/20050413075819/http://www.ultrasuede.com/products/swatches/light.html',
            'captured': '2005-04-13',
            'colors_listed': len(s2005),
        },
        {
            'id': 'uscom-light-fashion-2005',
            'kind': 'swatch_page',
            'title': 'Ultrasuede® light (Fashion) — STYLE #801',
            'site': 'ultrasuede.com',
            'original_url': 'http://www.ultrasuede.com/products/fashion/swatches/light.html',
            'archive_url': f'{WAYBACK}/20050211161710/http://www.ultrasuede.com/products/fashion/swatches/light.html',
            'captured': '2005-02-11',
            'colors_listed': len(s2005f),
        },
        {
            'id': 'colorcard-light-2010',
            'kind': 'color_card',
            'title': 'Ultrasuede® Light colour card (style 801)',
            'site': 'ultrasuede.com',
            'original_url': 'http://www.ultrasuede.com/b2b_center/color_cards/ultrasuede_light.pdf',
            'archive_url': f'{WAYBACK}/20101207051220/http://www.ultrasuede.com/b2b_center/color_cards/ultrasuede_light.pdf',
            'captured': '2010-12-07',
            'local_file': 'colorcards/ultrasuede_light_2010-12-07.pdf',
            'colors_listed': len(cards['colorcard-light-2010']),
        },
        {
            'id': 'colorcard-lt-2017',
            'kind': 'color_card',
            'title': 'Ultrasuede® LT colour card (style 8801)',
            'site': 'ultrasuede.us',
            'original_url': 'http://www.ultrasuede.us/resources/b2b_center/color_cards/ultrasuede_lt.pdf',
            'archive_url': f'{WAYBACK}/20170519095406/http://www.ultrasuede.us/resources/b2b_center/color_cards/ultrasuede_lt.pdf',
            'captured': '2017-05-19',
            'local_file': 'colorcards/ultrasuede_lt_2017-05-19.pdf',
            'colors_listed': len(cards['colorcard-lt-2017']),
            'note': ('Still served at ultrasuede.us/support/pdf/ultrasuede_lt.pdf in 2022; '
                     'that capture is byte-identical but was truncated by the crawler at '
                     '1 MiB, so the complete 2017 file is the one kept here.'),
        },
        {
            'id': 'uscom-lt-2020',
            'kind': 'product_page',
            'title': 'Ultrasuede® LT product page',
            'site': 'ultrasuede.com',
            'original_url': 'http://www.ultrasuede.com/products/lt.html',
            'archive_url': f'{WAYBACK}/20200604194123/http://www.ultrasuede.com/products/lt.html',
            'captured': '2020-06-04',
            'colors_listed': len(lt2020),
        },
    ]

    # --- 4. colours ---------------------------------------------------------
    colors = []
    for code in codes:
        name = names[code]
        sku = f'{style}-{code}'

        first_true = last_true = None
        for c in populated:
            if c['colors'][code]['orderable']:
                last_true = c['ts']
                first_true = first_true or c['ts']
        still_orderable = populated[-1]['colors'][code]['orderable']
        orderable_until = None if still_orderable else (iso(last_true) if last_true else None)

        in_2005 = name in by_name_2005
        former = []
        if in_2005 and by_name_2005[name] != code:
            former.append({
                'code': by_name_2005[name],
                'style': '801',
                'source': 'uscom-light-2005',
                'note': f'renumbered to {code} by 2010',
            })

        used = ['swatches-lt']
        if code in s2010:
            used.append('uscom-light-2010')
        if in_2005:
            used.append('uscom-light-2005')
            if name in {n for n in s2005f.values()}:
                used.append('uscom-light-fashion-2005')
        for cid, members in cards.items():
            if code in members:
                used.append(cid)
        if code in lt2020:
            used.append('uscom-lt-2020')

        thumb = f'images/{sku}.jpg'
        large = f'images/large/{sku}.jpg'
        has_large = os.path.exists(os.path.join(ROOT, large))
        img_path = os.path.join(ROOT, large if has_large else thumb)
        rgb = sample_color(img_path)

        entry = {
            'name': name,
            'slug': slugify(name),
            'sku': sku,
            'code': code,
            'hex': hexstr(rgb),
            'rgb': rgb,
            'nap': nap(img_path, rgb),
            'image': thumb,
            'image_large': large if has_large else None,
            'source': f'{WAYBACK}/{latest["ts"]}/{idx_url}',
            'sources': sorted(set(used)),
            'first_listed': '2005-04-13' if in_2005 else '2010-12-01',
            'last_listed': iso(latest['ts']),
            'last_year_listed': int(latest['ts'][:4]),
            'on_color_cards': sorted(
                cid.rsplit('-', 1)[1] for cid, m in cards.items() if code in m),
            'online_sample_orderable_until': orderable_until,
        }
        if former:
            entry['former_skus'] = former
        colors.append(entry)

    # By number rather than by name. Toray's four-digit codes group the line by
    # family — 1xxx reds, 2xxx blues, 3xxx browns and tans, 4xxx greens,
    # 5xxx golds and neutrals, 6xxx pinks and purples, 7xxx aquas — so this is
    # the maker's own arrangement of the colours rather than the alphabet's,
    # which puts Admiral beside Amatista and nothing beside anything. The sku
    # is 8801 and this code, so ordering by one is ordering by the other. The
    # custom colours and the prints below are ordered the same way, off the
    # numbers they carry instead.
    colors.sort(key=lambda c: number_key(c['code']))

    # --- 5. Light Jungle Collection ----------------------------------------
    # Read every archived capture, not just the last one, so the patterns get
    # the same first/last-listed treatment as the solid colours.
    jcaps = []
    for fn, ts, url, parser in JUNGLE_CAPTURES:
        rows = (parser or parse_jungle)(os.path.join(h, fn))
        jcaps.append({'ts': ts, 'url': url or JUNGLE_URL,
                      'rows': {(r['pattern'], r['color']): r for r in rows}})

    # as with the solid colours, the claim that the line-up never changed is
    # the point of the dataset, so assert it rather than trusting it.
    jkeys = set(jcaps[-1]['rows'])
    for c in jcaps:
        assert set(c['rows']) == jkeys, f'{c["ts"]} pattern set differs'
        for k, r in c['rows'].items():
            assert r['name'] == jcaps[-1]['rows'][k]['name'], f'{c["ts"]} {k} renamed'

    jsrc_of = {
        'http://www.ultrasuede.com/b2b/JungleLight.html': 'uscom-b2b-jungle-light-2001',
        'http://www.ultrasuede.com/products/fashion/swatches/light_jungle.html':
            'uscom-light-jungle-fashion-2005',
        JUNGLE_URL: 'uscom-light-jungle',
    }
    jlatest = jcaps[-1]
    patterns = []
    for key in sorted(jkeys, key=lambda k: (jcaps[-1]['rows'][k]['name'].lower(), k[1])):
        p = jlatest['rows'][key]
        img = f'images/jungle/{p["stem"]}.jpg'
        has_img = os.path.exists(os.path.join(ROOT, img))
        # the asterisk convention only exists on the products/swatches pages,
        # so the stock history is read from those captures alone.
        stocked = [c for c in jcaps if c['rows'][key]['in_stock'] is not None]
        had = [c for c in stocked if c['rows'][key]['in_stock']]
        lost = (iso(had[-1]['ts'])
                if had and not stocked[-1]['rows'][key]['in_stock'] else None)
        patterns.append({
            'name': p['name'],
            'slug': f'{slugify(p["name"])}-{p["color"]}',
            'pattern': p['pattern'],
            'color': p['color'],
            'image': img if has_img else None,
            'image_provenance': (
                None if not has_img
                else 'fields_live' if p['stem'] in JUNGLE_FIELDS_SCAN
                else 'reference_photo' if p['stem'] in JUNGLE_UNARCHIVED
                else 'wayback'),
            'source': f'{WAYBACK}/{jlatest["ts"]}/{jlatest["url"]}',
            'sources': sorted({jsrc_of[c['url']] for c in jcaps}),
            'first_listed': iso(jcaps[0]['ts']),
            'last_listed': iso(jlatest['ts']),
            'last_year_listed': int(jlatest['ts'][:4]),
            'stock': 'in stock' if p['in_stock'] else 'special order',
            'in_stock_until': lost,
        })

    # --- 5a. what each colour number is --------------------------------------
    # The colour number is the ink combination rather than the print, so it is
    # read once per number and shared by every pattern carrying it. That is
    # also what gives Bobcat 231 its palette: its own photograph is a Field's
    # scan with their logo across it and a warmer cast than Toray's captures,
    # so it is shown and not measured, and 231 is read off Baby Cougar and
    # Jaguar, where it is the same two inks.
    named = colorway_names()
    inks = {p['slug']: print_inks(os.path.join(ROOT, p['image']))
            for p in patterns
            if p['image'] and p['image_provenance'] != 'fields_live'}
    colorways = {}
    for code in sorted({p['color'] for p in patterns}):
        read = [(p, inks[p['slug']]) for p in patterns if p['slug'] in inks
                and p['color'] == code]
        assert read, f'colourway {code}: no photographed pattern to read'
        counts = {len(i) for _p, i in read}
        assert len(counts) == 1, \
            f'colourway {code} reads as {sorted(counts)} inks on its patterns'
        depth = counts.pop()

        if code in named:
            names, source = named[code]['names'], 'fields_catalog'
        else:
            names, source = COLORWAY_ESTIMATED[code], 'estimated'
        assert len(names) == depth, \
            f'colourway {code}: {len(names)} names for {depth} inks'

        colors_ = []
        for i, name in enumerate(names):
            # the median across every pattern printed in this colourway: one
            # ink photographed four or six times, not four or six inks
            rgb = np.median([ink[i]['rgb'] for _p, ink in read],
                            axis=0).round().astype(int)
            colors_.append({
                'name': name,
                'hex': hexstr(rgb),
                'rgb': [int(v) for v in rgb],
                'coverage': round(float(np.mean(
                    [ink[i]['share'] for _p, ink in read])), 3),
            })
        colorways[code] = {
            'code': code,
            'name': '/'.join(names),
            'name_source': source,
            'colors': colors_,
            'sampled_from': [p['slug'] for p, _i in read],
            'hex_source': ('reference_photo' if any(
                p['image_provenance'] == 'reference_photo' for p, _i in read)
                else 'archived_photo'),
        }
        if code in named:
            colorways[code]['named_in'] = sorted(named[code]['sources'])
            colorways[code]['named_on'] = sorted(
                f'{pat}-{col}' for pat, col in named[code]['seen_on'])

    assert set(colorways) == set(named) | set(COLORWAY_ESTIMATED), \
        'a colourway is named that no pattern carries, or the reverse'
    for p in patterns:
        p['colorway'] = colorways[p['color']]

    jhist = [c for c in jcaps if c['url'] == JUNGLE_URL]
    sources += [
        {
            'id': 'uscom-b2b-jungle-light-2001',
            'kind': 'swatch_page',
            'title': 'Ultrasuede® Light - Jungle Collection (b2b centre)',
            'site': 'ultrasuede.com',
            'original_url': 'http://www.ultrasuede.com/b2b/JungleLight.html',
            'archive_url': f'{WAYBACK}/20010527044853/'
                           'http://www.ultrasuede.com/b2b/JungleLight.html',
            'captured': '2001-05-27',
            'colors_listed': len(patterns),
            'note': 'earliest archived listing of the collection; the same 17 '
                    'patterns, under older image names and with no in-stock marks',
        },
        {
            'id': 'uscom-light-jungle-fashion-2005',
            'kind': 'swatch_page',
            'title': 'Ultrasuede® Light Jungle Collection (fashion section)',
            'site': 'ultrasuede.com',
            'original_url': 'http://www.ultrasuede.com/products/fashion/'
                            'swatches/light_jungle.html',
            'archive_url': f'{WAYBACK}/20050211162424/http://www.ultrasuede.com/'
                           'products/fashion/swatches/light_jungle.html',
            'captured': '2005-02-11',
            'colors_listed': len(patterns),
        },
        {
            'id': 'uscom-light-jungle',
            'kind': 'swatch_page',
            'title': 'Ultrasuede® Light Jungle Collection',
            'site': 'ultrasuede.com',
            'original_url': JUNGLE_URL,
            'latest_archive_url': f'{WAYBACK}/{jhist[-1]["ts"]}/{JUNGLE_URL}',
            'captures': [{'date': iso(c['ts']), 'patterns_listed': len(c['rows']),
                          'archive_url': f'{WAYBACK}/{c["ts"]}/{JUNGLE_URL}'}
                         for c in jhist],
            'note': '15 captures exist between 2005-04-13 and 2009-04-11; the six '
                    'listed here are every distinct version (the rest are '
                    'byte-identical repeats). No capture after 2009-04-11.',
        },
    ]

    # --- 6. Field's Fabrics custom colours ----------------------------------
    fdir = os.path.join(HERE, 'snapshots/fields')

    # (a) every Field's LT product we hold a capture history for, keyed by code
    products = {}
    for p in sorted(glob.glob(os.path.join(HERE, 'cdx_fields', 'p_*.json'))):
        pid = re.search(r'p_(\d+)\.json', p).group(1)
        allcaps = fields_product_captures(pid)
        caps = [c for c in allcaps if c['status'] == '200']
        assert caps, f'p_{pid} has no successful captures'
        # three digits as well as four: every Field's colour number is four
        # except LT Blue, which they number 100.
        code = re.search(r'\b(\d{3,4})\b',
                         caps[-1]['title'].split('LT', 1)[-1]).group(1)
        name = fields_label_name(caps[-1]['title'], code)
        # a redirect capture still proves the product existed under its old URL,
        # which is how the one rename in the record (Black Berry -> Blackberry)
        # shows up at all.
        former = [
            {'name': fields_label_name(c['title'], code),
             'captured': iso(c['ts']),
             'source': f'{WAYBACK}/{c["ts"]}/{c["url"]}',
             'note': f'URL captured as HTTP {c["status"]}; the product already '
                     'existed under this name'}
            for c in allcaps
            if c['status'] != '200'
            and slugify(fields_label_name(c['title'], code)) != slugify(name)
        ]
        products[code] = {'product_id': pid, 'captures': caps, 'all': allcaps,
                          'name': name, 'former_names': former}

    # (b) the two category listings, oldest first
    listings = []
    for fn in sorted(glob.glob(os.path.join(fdir, 'lt*.html'))):
        ts = re.search(r'(\d{14})', fn).group(1)
        kind = 'custom' if 'ltcustom' in os.path.basename(fn) else 'lt'
        listings.append({'ts': ts, 'kind': kind, 'items': parse_fields_listing(fn),
                         'url': FIELDS_CUSTOM_URL if kind == 'custom' else FIELDS_LT_URL})
    listings.sort(key=lambda c: (c['kind'], c['ts']))
    in_custom_cat = {c for l in listings if l['kind'] == 'custom' for c in l['items']}

    # (c) which product pages carry Field's own exclusivity claim
    exclusive = {}
    for fn in sorted(glob.glob(os.path.join(fdir, 'products', '*.html'))):
        raw = open(fn, encoding='utf-8', errors='replace').read()
        if not raw.strip():
            continue
        flat = re.sub(r'\s+', ' ', html.unescape(re.sub(
            r'<[^>]+>', ' ', re.sub(r'(?is)<(script|style)  .*?</\1>', ' ', raw))))
        m = EXCLUSIVE_RE.search(flat)
        if m:
            exclusive[re.match(r'(\d+)', os.path.basename(fn)).group(1)] = m.group(0)

    official_codes = {c['code'] for c in colors}
    # An LT colour Field's sold that is not one of Toray's 36 is a custom colour.
    # Absence from the official swatch pages is the whole test: Field's own
    # "Premium Color only Available at Field's Fabrics" claim is kept as evidence
    # on the entries that carry it, but it is neither necessary nor sufficient —
    # Field's also applies it to three genuine Toray colours, which the official
    # check excludes.
    custom_codes = sorted(set(products) - official_codes)
    claimed = set(exclusive) | in_custom_cat
    # codes Field's marks exclusive that are in fact part of the official line
    overlap = sorted(claimed & official_codes)
    # custom colours resting on absence alone, with no claim from Field's
    assumed = sorted(set(custom_codes) - claimed)

    def listing_history(code):
        """[(date, kind, still-offered?, archive_url)] for a code, oldest first."""
        out = []
        for l in listings:
            it = l['items'].get(code)
            if it:
                out.append((iso(l['ts']), l['kind'], not GONE_RE.search(it['label']),
                            f'{WAYBACK}/{l["ts"]}/{l["url"]}'))
        return out

    def fields_entry(code):
        p = products[code]
        caps = p['captures']
        hist = listing_history(code)
        # "listed" means offered, not merely still having a page: a title or
        # label reading "Sold Out"/"Discontinued" does not count.
        live = ([(d, u) for d, _k, ok, u in hist if ok] +
                [(iso(c['ts']), c['url']) for c in caps if not c['gone']])
        live.sort()
        gone_marks = ([d for d, _k, ok, _u in hist if not ok] +
                      [iso(c['ts']) for c in caps if c['gone']])
        img = f'images/fields/{code}.jpg'
        has_img = os.path.exists(os.path.join(ROOT, img))
        corners = code not in FIELDS_IMG_UNMARKED
        sample = sample_color_corners if corners else sample_color
        rgb = sample(os.path.join(ROOT, img)) if has_img else None
        latest_listing = hist[-1] if hist else None
        # where an archived thumbnail survives, keep it as a second reading:
        # Field's two generations of photography disagree noticeably.
        check = None
        for arch in glob.glob(os.path.join(ROOT, f'images/fields/archived/{code}_*.jpg')):
            d = re.search(r'_(\d{4}-\d{2}-\d{2})\.jpg$', arch).group(1)
            arch_rgb = sample_color_corners(arch)
            check = {
                'image': os.path.relpath(arch, ROOT),
                'captured': d,
                'hex': hexstr(arch_rgb),
                'rgb': arch_rgb,
                'archive_url': f'{WAYBACK}/{d.replace("-", "")}'
                               f'{FIELDS_THUMB_TS[code]}/http://shop.fieldsfabrics.com'
                               f'/assets/images/ultrasuede/{code}_thumbnail.jpg',
            }
        entry = {
            'name': p['name'],
            'slug': slugify(p['name']),
            'code': code,
            'sku': None,           # Toray never gave these an 8801- SKU
            'hex': hexstr(rgb) if rgb else None,
            'rgb': rgb,
            'nap': nap(os.path.join(ROOT, img) if has_img else None, rgb,
                       corners=corners, measure=False),
            'image': img if has_img else None,
            'image_source': (f'{FIELDS}/{FIELDS_IMG_PATH[code]}'
                             if code in FIELDS_IMG_PATH
                             else f'{FIELDS}/assets/images/{code}.jpg'
                             if code in FIELDS_IMG_FLAT
                             else f'{FIELDS}/assets/images/ultrasuede/{code}.jpg'),
            'image_provenance': 'live_site' if has_img else None,
            'image_retrieved': date.today().isoformat() if has_img else None,
            'archived_swatch': check,
            'source': (latest_listing[3] if latest_listing
                       else f'{WAYBACK}/{caps[-1]["ts"]}/{caps[-1]["url"]}'),
            'sources': sorted(
                {'fields-lt-custom' if k == 'custom' else 'fields-lt'
                 for _d, k, _ok, _u in hist} | {f'fields-product-{code}'}),
            'first_listed': live[0][0] if live else None,
            'last_listed': live[-1][0] if live else None,
            'last_year_listed': int(live[-1][0][:4]) if live else None,
            'exclusive_to': "Field's Fabrics",
            # how the entry earned its place: Field's says so, or nothing in
            # Toray's own record ever does.
            'custom_basis': ('fields_exclusivity_claim' if code in claimed
                             else 'absent_from_official_line'),
            'exclusivity_evidence': exclusive.get(code),
            'in_custom_category': code in in_custom_cat,
            'fields_product_id': p['product_id'],
            'product_url': f'{FIELDS}/{unquote(caps[-1]["url"]).rsplit("/", 1)[-1]}',
            'product_page_first_seen': iso(caps[0]['ts']),
            'product_page_last_seen': iso(caps[-1]['ts']),
            'product_page_source': f'{WAYBACK}/{caps[-1]["ts"]}/{caps[-1]["url"]}',
            # earliest date anything in the record mentions the colour at all —
            # a listing, or a product URL even when it answered with a redirect.
            'earliest_evidence': min([iso(p['all'][0]['ts'])] +
                                     [d for d, _k, _ok, _u in hist]),
            'sold_out_noted': min(gone_marks) if gone_marks else None,
            'status': 'discontinued' if gone_marks else 'unknown',
        }
        if code in OFF_PAGE:
            entry['on_page'] = False
            entry['off_page_reason'] = OFF_PAGE[code]
        if p['former_names']:
            entry['former_names'] = p['former_names']
        back = next(((h, v) for h, v in HISTORICAL_SEE_ALSO.items()
                     if v['code'] == code), None)
        if back:
            entry['see_also'] = {'code': back[0], 'set': None,
                                 'note': back[1]['back']}
        return entry

    custom_colors = sorted((fields_entry(c) for c in custom_codes),
                           key=lambda e: number_key(e['code']))

    # no custom colour may collide with the 36, by code or by name.
    cset = {c['code'] for c in custom_colors}
    assert len(cset) == len(custom_colors), 'duplicate custom code'
    assert cset.isdisjoint(official_codes), 'custom/official code overlap'
    assert not {c['name'].lower() for c in custom_colors} & \
           {c['name'].lower() for c in colors}, 'custom/official name collision'

    sources += [
        {
            'id': 'fields-lt-custom',
            'kind': 'retailer_category',
            'title': "Ultrasuede® LT Custom Colors — Field's Fabrics",
            'site': 'shop.fieldsfabrics.com',
            'original_url': FIELDS_CUSTOM_URL,
            'latest_archive_url': f'{WAYBACK}/{listings[-1]["ts"]}/{FIELDS_CUSTOM_URL}'
                                  if listings else None,
            'captures': [{'date': iso(l['ts']), 'colors_listed': len(l['items']),
                          'archive_url': f'{WAYBACK}/{l["ts"]}/{FIELDS_CUSTOM_URL}'}
                         for l in listings if l['kind'] == 'custom'],
            'note': ('The category mixes Field\'s exclusives with three genuine '
                     'Toray colours (' +
                     ', '.join(f'{c} {n}' for c, n in
                               sorted((c, next(x["name"] for x in colors
                                               if x["code"] == c)) for c in overlap)) +
                     '), which are recorded under colors: and excluded here.'),
        },
        {
            'id': 'fields-lt',
            'kind': 'retailer_category',
            'title': "Ultrasuede® LT (Light) — Field's Fabrics",
            'site': 'shop.fieldsfabrics.com',
            'original_url': FIELDS_LT_URL,
            'captures': [{'date': iso(l['ts']), 'colors_listed': len(l['items']),
                          'archive_url': f'{WAYBACK}/{l["ts"]}/{FIELDS_LT_URL}'}
                         for l in listings if l['kind'] == 'lt'],
            'note': "Field's main LT catalogue; carries the standard Toray "
                    'colours alongside a few Toray never listed officially.',
        },
    ] + [
        {
            'id': f'fields-product-{e["code"]}',
            'kind': 'retailer_product',
            'title': f'{e["name"]} (#{e["code"]}) — Field\'s Fabrics product page',
            'site': 'shop.fieldsfabrics.com',
            'original_url': e['product_url'],
            'latest_archive_url': e['product_page_source'],
            'captures': [
                {'date': iso(c['ts']), 'offered': not c['gone'],
                 'archive_url': f'{WAYBACK}/{c["ts"]}/{c["url"]}'}
                for c in products[e['code']]['captures']],
        }
        for e in custom_colors
    ]

    # --- 7. the pre-2011 Light record Toray never held -----------------------
    old_lists = historical_colors(colors)

    def recover(e):
        """A pre-2011 colour whose scan turned up, in the custom colours' shape.

        Field's hung a swatch scan off every colour number on those list pages —
        "Click on color number to see a swatch" — and the Wayback Machine kept
        forty-seven of them. A colour with a scan is no longer a name and a date;
        it has a hex, a nap and a picture, which is everything the other Field's
        colours have, so it is shown with them rather than filed under what the
        record could not produce.

        It does not follow that Field's had these made. The line's own public
        record does not start until 2005 and these were being sold from 2002, so
        absence from Toray's 36 cannot tell a colour Field's commissioned from an
        early official colour Toray dropped before it had a website to drop it
        from — which is what custom_basis says outright, and why none of these
        claims exclusive_to.
        """
        return dict(e, **{
            'archived_swatch': None,
            'first_listed': e['first_seen'],
            'last_listed': e['last_seen'],
            'last_year_listed': int(e['last_seen'][:4]),
            'exclusive_to': None,
            'custom_basis': 'predates_official_record',
            'exclusivity_evidence': None,
            'in_custom_category': False,
            'status': 'discontinued',
        })

    historical = [e for e in old_lists if not e['rgb']]
    # Same rule as the 36: Field's numbers carry the same families, so Active
    # Green sits at 4599 among the greens rather than at the top of the list
    # for starting with an A.
    custom_colors = sorted(custom_colors + [recover(e) for e in old_lists
                                            if e['rgb']],
                           key=lambda e: number_key(e['code']))

    # the same two rules as before the merge, over the merged set
    cset = {c['code'] for c in custom_colors}
    assert len(cset) == len(custom_colors), 'duplicate custom code'
    assert cset.isdisjoint(official_codes), 'custom/official code overlap'

    # A see_also names the set its target sits in, and which set that is was
    # only settled a few lines ago: recovering #2894 Imperial Blue's scan moved
    # it in beside the #2694 Imperial Blue that points back at it.
    where = dict([(c['code'], 'custom_colors') for c in custom_colors] +
                 [(e['code'], 'historical_colors') for e in historical])
    for e in custom_colors + historical:
        if 'see_also' in e:
            e['see_also']['set'] = where[e['see_also']['code']]

    # A slug is an identifier, so it has to be unique across everything the file
    # holds, and recovering #2894's scan put both Imperial Blues in one list.
    # Two colours with one name is the data being right rather than wrong, so
    # the number settles it instead of one of them giving up the name.
    numbered = colors + custom_colors + historical
    taken = {}
    for e in numbered:
        taken[e['slug']] = taken.get(e['slug'], 0) + 1
    for e in numbered:
        if taken[e['slug']] > 1:
            e['slug'] = f'{e["slug"]}-{e["code"]}'

    sources += [
        {
            'id': 'fields-old-light-lists',
            'kind': 'retailer_category',
            'title': "Ultrasuede® Light colour lists — Field's Fabrics, 2002–2010",
            'site': 'fieldsfabrics.com',
            'original_url': 'http://www.fieldsfabrics.com/ultra/lgtlist.htm',
            'captures': sorted(
                {(c['date'], c['archive_url'])
                 for e in old_lists for c in e['captures']
                 if c['in'] != "Field's Ultrasuede catalogue"}),
            'colors_listed': len(old_lists),
            'note': "Field's Light 45\" and Light Extrawide 58\" list pages, 108 "
                    'captures between 2002-08 and 2010-03. The pages moved twice '
                    '(/shopping/ultra/ to /ultra/, with and without the www), so '
                    'each capture carries the URL it was actually taken from. '
                    'Saved under research/fields_oldsite/.',
        },
        {
            'id': 'fields-ultrasuede-catalogs',
            'kind': 'catalog',
            'title': "Field's Fabrics printed Ultrasuede catalogue",
            'site': 'fieldsfabrics.com',
            'captures': [{'date': issue,
                          'archive_url': f'{WAYBACK}/{ts}/{url}'}
                         for issue, (ts, url) in sorted(FIELDS_CATALOGS.items())],
            'note': 'Nine issues, 2005-03 to 2010-02, each a price list naming '
                    'every colour Field\'s stocked by line and width. The 2008-08 '
                    'issue is a JBIG2 scan with no text layer and was read from a '
                    'render. Saved under research/fields_catalogs/.',
        },
        {
            'id': 'fields-sample-set-catalogs',
            'kind': 'catalog',
            'title': "Field's Fabrics swatch-set list",
            'site': 'shop.fieldsfabrics.com',
            'captures': [
                {'date': '2020-03',
                 'archive_url': f'{WAYBACK}/20210119104540/https://shop.'
                                'fieldsfabrics.com/assets/images/pdf/Fields_'
                                'Fabrics_Ultrasuede_Ultraleather_Sample_Set_'
                                '2003.pdf'},
                {'date': 'current',
                 'original_url': 'https://shop.fieldsfabrics.com/assets/images/'
                                 'pdf/Fields_Fabrics_Ultrasuede_Ultraleather_'
                                 'Sample_Set.pdf'},
            ],
            'note': 'The list that ships with the Ultrasuede swatch set, long '
                    'after the Jungle collection itself was gone. It is the only '
                    'thing held here that names colourway 231 — "176-231-58 '
                    'Jaguar Tan/Black" — and it names 023 the same way the '
                    'catalogues do. Saved under research/fields_sample_sets/.',
        },
    ]

    # --- 8. assemble --------------------------------------------------------
    empty = [c for c in captures if not c['colors']]
    data = {
        'meta': {
            'product': 'Ultrasuede® LT',
            'also_known_as': ['Ultrasuede® Light'],
            'manufacturer': 'Toray',
            'status': 'discontinued',
            'color_count': len(colors),
            'pattern_count': len(patterns),
            'historical_color_count': len(historical),
            'recovered_color_count': sum(
                1 for c in custom_colors
                if c['custom_basis'] == 'predates_official_record'),
            'style_numbers': [
                {'number': '801', 'era': '2005–2010',
                 'note': 'on the 2005 swatch pages and the 2010 Light colour card'},
                {'number': style, 'era': '2010–2024',
                 'note': f'SKU prefix from 2010; "Style: {style}" on the 2017 LT card'},
            ],
            'composition': ('80% polyester ultra-microfiber non-woven with '
                            '20% non-fibrous polyurethane binder'),
            'width': '58" / 1,480mm',
            'weight': '5.0 oz per sq. yard / 170g per square meter',
            'thickness': '0.6mm',
            'fiber_fineness': '0.04 denier',
            'first_official_listing': '2005-02-11',
            'last_official_listing': iso(latest['ts']),
            'delisted_by': iso(empty[0]['ts']) if empty else None,
            'compiled': date.today().isoformat(),
            'about': ('Reconstructed from Wayback Machine captures of Toray’s own '
                      'swatch sites and colour cards. Every entry carries the '
                      'archive URL it came from.'),
            'rebuild': 'python3 scraping/build_dataset.py',
            'color_note': ('hex/rgb are sampled from swatch photographs, not official '
                           'Toray colour values, and are approximate. Official colours '
                           'and patterns use the median of a centre crop of the archived '
                           "image; the Field's entries use four corner patches instead, "
                           'to keep their watermark out of the sample.'),
            'nap_note': (
                'Every colour also carries a `nap` block, which is what the site '
                'draws instead of the photograph: `axis` is the direction the '
                "fabric's light-and-dark variation runs through RGB, regressed "
                'against luminance over the same pixels the hex is sampled from, '
                'and normalised so its own luminance is 1; `contrast` is the '
                'standard deviation of that variation in 0–255 luminance units. '
                'The variation is additive and very nearly achromatic in these '
                'photographs — a nap highlight is the base colour plus a constant, '
                'not the base colour scaled — so those two numbers plus the hex '
                'describe the whole colour range of a swatch. Both numbers are '
                'read off the photograph with its finest, pixel-scale band blurred '
                'away first: that band holds 80% of the raw variance but its '
                'horizontal lag-1 autocorrelation is negative, which makes it the '
                "camera's noise rather than the cloth's texture. What survives is "
                'a fine mottle around 100 cycles across the frame carrying 45% of '
                'the variation and a broad cloud slower than 3 cycles carrying '
                '36%, with a thin tail between, and it is isotropic to within a '
                'few percent. `contrast` is the summed standard deviation of those '
                'five bands, measured wherever a full-frame photograph of at least '
                '300px exists; `contrast_source` says `modeled` where one does '
                'not, and it is then read off the curve those measurements fit '
                f'({NAP_FIT[0]}·x^{NAP_FIT[1]}·(1−x)^{NAP_FIT[2]} for x = L/255, '
                'R² = 0.70) — nap contrast rises with a swatch’s own lightness and '
                'falls away again near white. That curve is read only over the '
                'lightness range it was fitted on, L = 25 to L = 241, and held '
                'flat outside it rather than extrapolated — which affects '
                'Burgundy alone, the one modelled colour darker than any '
                'measured one. '
                "The Field's photographs are modelled "
                'too: they are shot at a coarser magnification than Toray’s, so '
                'measuring them would make those 13 disagree with the other 36 '
                'about a property of the fabric rather than of the camera. '
                'Light Jungle is printed, not piece-dyed, and has no nap block.'),
            'light_jungle': {
                'name': 'Ultrasuede® Light Jungle Collection',
                'pattern_count': len(patterns),
                'first_official_listing': iso(jcaps[0]['ts']),
                'last_official_listing': iso(jlatest['ts']),
                'delisted_by': '2010-12-01',
                'delisted_evidence': (
                    'the printed collection outlived none of the site rebuild: it '
                    'has no capture after 2009-04-11, and it is absent from the '
                    'product menu of the 2010-12-01 swatch site, which still lists '
                    'Ultrasuede® Ambiance Jungle. It never appeared on '
                    'swatches.ultrasuede.us, which carried HP Jungle from 2016.'),
                'colorway_note': (
                    'Eleven patterns in seventeen entries: six of them — Baby '
                    'Cougar, Bobcat, Cheetah, Jaguar, Python and Small Pony — '
                    'were sold in two colourways each, and Toray listed both on '
                    'the same page. Two entries sharing a name are that, not a '
                    'duplicate; `pattern` is the same for the pair and `color` '
                    'is what differs.'),
                'color_number_note': (
                    'The colour number is the ink combination, not a serial: ten '
                    'numbers across seventeen entries, 023 on six of them and 231 '
                    'on three, and a pattern sold twice is one drawing run in two '
                    "sets of inks. Field's Fabrics printed the combination beside "
                    'the number in their own catalogues — 023 is Cream/Black under '
                    'four different pattern numbers across nine issues, 231 is '
                    'Tan/Black and 232 is Cream/Brown — and those three carry '
                    'name_source: fields_catalog. The other seven were never named '
                    'in anything archived here and carry name_source: estimated: '
                    'the names are read off the photographs, like the hexes beside '
                    'them, and are descriptions rather than anyone else\'s name '
                    'for them.'),
                'colorway_hex_note': (
                    'Each colourway carries the inks its prints were run in rather '
                    'than one hex, read by clustering the photographs in CIELAB and '
                    'taking the median of each cluster\'s eroded core — the middle '
                    'of a region, with the blend of colours along its own boundary '
                    'cut away. How many inks there are is read the same way: a '
                    'cluster asked for beyond the real ones is the blend shell '
                    'itself, and erosion empties it, so the count stops where a '
                    'cluster loses its core. Thirteen prints read as two inks and '
                    'two — Leopard 210 and Ocelot 154 — as three. A colourway '
                    'printed on several patterns is the median across all of them, '
                    'which is what gives Bobcat 231 its palette: its own '
                    'photograph is a Field’s scan with their logo across the '
                    'middle and a warmer cast than Toray’s captures, so it is '
                    'shown but not measured, and 231 is read off Baby Cougar and '
                    'Jaguar. Ocelot 154 is the one colourway read off a reference '
                    'photograph rather than an archived capture, and says so as '
                    'hex_source: reference_photo. Approximate, like every other '
                    'colour in this file.'),
                'image_note': (
                    'Toray’s swatch photographs survive for 15 of the 17. The '
                    'Wayback Machine holds no capture of bobca231.jpg or '
                    'ocelo154.jpg under any path the site ever used, so neither '
                    'Bobcat 231 nor Ocelot 154 has an archived image. Bobcat 231 '
                    'has one anyway: Field’s Fabrics still serve a flatbed scan '
                    'of the print under the pattern’s own number, and it carries '
                    '`image_provenance: fields_live`. Ocelot 154 is shown from a '
                    'reference photograph and carries `image_provenance: '
                    'reference_photo` — a hand-supplied stand-in, not evidence.'),
            },
            'fields_custom': {
                'name': "Ultrasuede® LT custom colours for Field's Fabrics",
                'retailer': "Field's Fabrics (shop.fieldsfabrics.com)",
                'color_count': len(custom_colors),
                'first_listed': min(c['first_listed'] for c in custom_colors
                                    if c['first_listed']),
                'last_listed': max(c['last_listed'] for c in custom_colors
                                   if c['last_listed']),
                'criterion': (
                    'Field\'s sold the colour as Ultrasuede® LT or Light and it is '
                    'not one of Toray\'s 36 — absence from the official swatch pages '
                    'is the whole test. Field\'s own claim, "Premium Color only Available '
                    "at Field's Fabrics\", is recorded where it appears but is not "
                    'required: they also print it on three genuine Toray colours (' +
                    ', '.join(f'{c} {n}' for c, n in
                              sorted((c, next(x['name'] for x in colors
                                              if x['code'] == c)) for c in overlap)) +
                    '), which the official check excludes.'),
                'excluded_as_official': overlap,
                'basis_counts': {
                    'fields_exclusivity_claim': sum(
                        1 for c in custom_colors
                        if c['custom_basis'] == 'fields_exclusivity_claim'),
                    'absent_from_official_line': len(assumed),
                    'predates_official_record': sum(
                        1 for c in custom_colors
                        if c['custom_basis'] == 'predates_official_record'),
                },
                'predates_note': (
                    'A colour marked custom_basis: predates_official_record was '
                    "sold by Field's as Ultrasuede® Light before 2011, and is here "
                    'because a picture of it turned up — its swatch scan in the '
                    "archive, or the photograph still on Field's own server — see "
                    'meta.historical. Toray\'s own record does not begin until '
                    '2005, so for these the absence test cannot do the work it '
                    'does elsewhere: each may be a colour Field\'s had made, or an '
                    'early official colour Toray dropped before it had a public '
                    'swatch page to drop it from. None of them claims exclusive_to '
                    'for that reason.'),
                'assumed_note': (
                    f'{len(assumed)} of these ({", ".join(assumed)}) carry no '
                    'exclusivity claim on any capture held here and sit in Field\'s '
                    'main LT category; they are taken as custom because Toray never '
                    'listed them. They may instead be survivors of the pre-2005 line '
                    '— the 2001 b2b page advertises "40 high-fashion colors" against '
                    'the 36 the archive can name. Each is marked '
                    'custom_basis: absent_from_official_line.'),
                'image_note': (
                    'Two generations of photograph, and they are not comparable. '
                    'The shop-era colours (image_provenance: live_site) are shot '
                    'from the live Field\'s site, not the archive, which holds '
                    'usable captures of only two of them (Blackberry and Rose '
                    'Quartz, 2016-05-30, 60px) — those are kept under '
                    'images/fields/archived/ and carried as archived_swatch, and '
                    'they read noticeably lighter than the current photographs. '
                    'The pre-2011 colours (archived_scan) are Field\'s own flatbed '
                    'scans out of the Wayback Machine, cropped to the cloth by '
                    'scraping/crop_old_swatches.py and sampled off the corners to '
                    'keep the Field\'s logo out of the reading. Nine pre-2011 '
                    'colours are marked live_site instead: no archive holds a '
                    'picture of them, but the file is still on Field\'s server '
                    'under the colour number, fetched by '
                    'scraping/fetch_live_swatches.py and read the same way. Two of '
                    'those nine are photographs of the colour in another weight, '
                    'and carry based_on saying which weight, which number, and the '
                    'catalogue sheet that prints the two numbers together. Every '
                    'hex in this set is approximate.'),
            },
            'historical': {
                'name': 'Ultrasuede® Light colours from before the official record',
                'retailer': "Field's Fabrics (fieldsfabrics.com, 2002–2010)",
                'color_count': len(historical),
                'listed_color_count': len(old_lists),
                'recovered_color_count': len(old_lists) - len(historical),
                'first_seen': min(e['first_seen'] for e in old_lists),
                'last_seen': max(e['last_seen'] for e in old_lists),
                'criterion': (
                    'Field\'s sold the colour as Ultrasuede® Light and neither '
                    'Toray\'s swatch pages nor Field\'s own later LT catalogue '
                    'ever carried the number — including as a former SKU, which '
                    'is what keeps White out of this list under its pre-2010 '
                    '#5832.'),
                'note': (
                    'Toray\'s own record starts in 2005 and never held more than '
                    'the 36; Field\'s was selling Light from 2002 in a much wider '
                    'range, which is the likeliest home of the "40 high-fashion '
                    'colors" the 2001 b2b page advertises. Names are transcribed '
                    'as printed, Field\'s typos included ("Eclispe", "Bourdeax"), '
                    'and a colour listed two ways keeps both under name_variants.'),
                'split_note': (
                    f'{len(old_lists)} colours came off these lists. The '
                    f'{len(old_lists) - len(historical)} a picture of which turned '
                    'up — in the archive, or still on Field\'s own server — are not '
                    'here: a colour with a hex, a nap and a '
                    'picture belongs with the other Field\'s colours, so they are '
                    'in custom_colors marked custom_basis: predates_official_record '
                    '— see meta.fields_custom.predates_note for why that basis is '
                    'not the same claim the rest of that set makes. What is left '
                    'here is the record with nothing to show for it.'),
                'image_note': (
                    'None of these has a swatch photograph, so none has a hex or a '
                    'nap block. Field\'s hung a scan off every colour number on the '
                    'list pages — /swatches/<number>.jpg — and the Wayback Machine '
                    'kept most of them, but not these: for these the scan was never '
                    'crawled at any size, or the number never appeared as a link '
                    'because the page carrying it was not archived. Nor is the '
                    'thumbnail index any help: of its 41 URLs, 39 answer 404, '
                    'placeholders from a 2018 crawl of a shop that had already '
                    'moved, and the two real captures are of colours that are not '
                    'in this set. What did help, for nine colours that used to be '
                    'in this list, is that Field\'s still serves the photograph '
                    'itself under the colour number even where nothing archived the '
                    'page — those are in custom_colors with '
                    'image_provenance: live_site, two of them showing the same '
                    'colour in another weight and saying so in based_on. Every '
                    'number left here was asked for at that address too. All '
                    'answered 404 but Green Glass #4619, which answers with a '
                    'photograph of a plain grey cloth — Field\'s numbers are '
                    'reused across their range, and a grey is not a colour called '
                    'Green Glass, so that file is taken to be another product and '
                    'is not shown.'),
                'excluded_as_other_line': (
                    'Azure Blue #4011, Raspberry #7565, Sandlewood #4083, Oriental '
                    'Teal #6502, Misty Spruce #4118, New Jade #4229 and Aqualine '
                    '#4600 sit under a "55\" Milano Upholstery weight" subsection '
                    'of the same Extrawide page and are Milano HP, not Light.'),
            },
        },
        'sources': sources,
        'colors': colors,
        'patterns': patterns,
        'custom_colors': custom_colors,
        'historical_colors': historical,
    }

    with open(os.path.join(ROOT, 'lt.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print(f'{len(old_lists)} pre-2011 Light colours, '
          f'{min(e["first_seen"] for e in old_lists)} to '
          f'{max(e["last_seen"] for e in old_lists)}: '
          f'{len(old_lists) - len(historical)} with a recovered scan, '
          f'{len(historical)} with nothing to show')
    print(f'{len(colorways)} Jungle colourways, '
          f'{sum(1 for w in colorways.values() if "named_in" in w)} named by '
          "Field's, " + ', '.join(f'{c} {w["name"]}' for c, w
                                  in sorted(colorways.items())))
    print(f'{len(colors)} colours, {len(patterns)} patterns, '
          f'{len(custom_colors)} Field\'s custom ({len(assumed)} on absence '
          f'alone), {len(sources)} sources')
    print(f'captures: {len(populated)} populated, {len(empty)} empty')
    print(f'large images: {sum(1 for c in colors if c["image_large"])}/{len(colors)}')
    print('wrote lt.json')


if __name__ == '__main__':
    main()
