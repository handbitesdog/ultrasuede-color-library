# Synthetic Suede Fabric Library

Colour data for synthetic suede — Toray's Ultrasuede® lines and the Japanese and
Korean cloths sold alongside them. One JSON file per product, every colour with
a hex sampled from a photograph, and the photograph it was sampled from.

Independent and non-commercial. Ultrasuede® is a registered trademark of Toray;
Lamous® and Shammy® are their respective owners' marks.

| file | product | colours | source |
|---|---|---|---|
| `lx.json` | Ultrasuede® LX | 25 | Toray's storefront, `sales.tum.toray` |
| `st.json` | Ultrasuede® ST | 36 + 6 historical | Toray's swatch site, live |
| `lt.json` | Ultrasuede® LT | 36 + 17 patterns + 70 custom + 13 historical | Wayback, reconstructed |
| `lamous-th.json` | Lamous®-TH | 49 | 美徳屋 (Mitokuya) |
| `shammy.json` | Shammy® 707J | 42 | 浅草ゆうらぶ (Asakusa Youlove) |
| `texvision-ds102.json` | DS102, Korean | 41 | eBay listing |

The page is `index.html` — static, but it fetches the JSON, so it needs a
server rather than `file://`:

```bash
python3 -m http.server 8123      # then http://localhost:8123/
```

## The shape of a product file

```jsonc
{
  "meta":     { ... },      // what the product is, and how to read the numbers
  "sources":  [ ... ],      // where the data came from
  "colors":   [ ... ],      // the current range

  // optional, only where a product has them:
  "patterns":          [ ... ],   // prints rather than solids — LT only
  "custom_colors":     [ ... ],   // made-to-order — LT only
  "historical_colors": [ ... ]    // named in the record, no longer sold
}
```

Every section is an array of colour entries in the same shape, so a consumer can
read one or all of them with one code path. The split is about what the entries
*are*, not how they are structured.

### `meta`

Present in every file:

| field | |
|---|---|
| `product` | display name, e.g. `"Ultrasuede® LX"` |
| `manufacturer` | `"Toray"`, or **`null` where the source does not say** — never inferred |
| `status` | `"current"` or `"discontinued"` |
| `color_count` | length of `colors` |
| `compiled` | ISO date the file was last built |
| `about` | prose: what this is and where it was read from |
| `rebuild` | the exact command that regenerates the file |
| `color_note` | **how the hexes were measured and how far to trust them** |

Common but not universal: `also_known_as`, `specifications`, `nap_note`,
`coverage_note`, `style_numbers`, `naming_note`, `not_recorded`.

The `*_note` fields are the honest part of this dataset and are worth reading
before using the numbers. `coverage_note` says whether a file is the whole range
or one sales channel's slice. `color_note` says what was photographed and how.

**Specs live in two places, for one bad reason.** Five products carry
`meta.specifications` (`composition`, `width`, `weight`, `thickness`, plus
whatever else the source published). `lt.json` predates that convention and
keeps the same four fields at the top level of `meta`. Read both — `specLine()`
in `site/js/demo.js` shows how. `lt.json` is a record and its shape is part of
it, so it was not rewritten to match.

### A colour entry

Always present:

| field | |
|---|---|
| `name` | colour name. Where a product has none, this is the code |
| `slug` | lowercased, non-alphanumerics to `-` |
| `image` | small swatch, path relative to the repo root |
| `source` | URL this entry came from — **per colour where the source allows** |

Present on everything that has a colour at all (i.e. not the historical
entries, which are a name and a number and nothing else):

| field | |
|---|---|
| `code` | the colour number — see the warning below |
| `sku` | style and colour together, e.g. `8023-5597` |
| `hex` / `rgb` | sampled, approximate, see `meta.color_note` |
| `nap` | how to draw the cloth without the photograph, or `null` |
| `image_large` | larger swatch |
| `sources` | ids into the top-level `sources` array |

Beyond that, entries carry whatever their source supports and no more —
`former_skus`, `name_variants`, `captures`, `first_listed`, `orderable`,
`sample_url`, `in_stock`, `variation_id`, `name_ja`, `shot`. Consumers should treat
anything outside the tables above as optional.

Two entry-level flags worth knowing: `on_page: false` keeps an entry in the file
but off the rendered page, with the reason in `off_page_reason` — the file is the
record, so nothing is deleted to change what is drawn. And `based_on` marks an
entry shown using a different weight's photograph, which the page says out loud.

### ⚠ `code` is not equally stable across products

It is frozen into anything downstream that stores a colour, so it matters which
kind you are holding:

- **Stable — a manufacturer colour number.** `lx` (`CD8`), `st` (`5597`),
  `lt` (`2467`), `lamous-th` (`TH001`), `shammy` (`SR22`, `40Y`).
- **Not stable.** `texvision-ds102` numbers colours `01`–`41` by *the seller's
  position in their own list*. If they reorder it, the codes move. Do not freeze
  these into stored data.

ST also renumbered wholesale — style `2223` → `8023` between 2019 and 2021, every
colour — so its survivors carry `former_skus`. A code is only stable within a
style.

### `nap`

What the site draws instead of the photograph, and the reason a swatch renders
crisp at any size from about forty bytes.

```jsonc
"nap": {
  "axis": [1.0331, 0.9759, 1.1416],   // direction the light/dark variation runs
                                      // through RGB, luminance-normalised to 1
  "contrast": 15.01,                  // std deviation of that variation, 0-255 luminance
  "contrast_source": "measured"
}
```

A pixel is `base + axis × contrast × t` for a unit-variance noise field `t` —
additive, not multiplicative, which is what stops a highlight on a red turning
pink. `site/js/nap.js` has the full derivation.

Those three numbers say what colour a swatch is and how far it moves, but not at
what *size* it moves, and that is not one answer across the library. `nap.js`
carries one shader per spectrum — a *weave* — and the product picks one:

| weave | | |
| --- | --- | --- |
| `cloud` | Ultrasuede and its copies | a broad field with a fine mottle on top and almost nothing between. Measured off the archive's swatch photographs |
| `grain` | Shammy 707J | the same broad field with the weight moved onto the nap, and the nap a denser, more even grain. Measured off the seller's close-up, the one picture in the library that resolves this cloth |

As a share of variance, in cycles across the frame — the ensemble-mean power
spectrum over 96 frames, which is what the broad band needs before it settles,
since three cycles across a frame realise wildly different variance frame to
frame:

| weave | 0–4 | 4–32 | 32+ |
| --- | --- | --- | --- |
| `cloud` | 30.2% | 5.8% | 65.3% |
| `grain` | 34.5% | 18.5% | 48.5% |

They share a broad end and part in the middle, which is the whole of what
distinguishes them: 18.5% against 5.8% at 4–32 cycles is a dense even grain
against a thin mottle.

They are the same kind of cloth photographed at the same magnification, so they
share a broad end and differ where the difference is. Drawing Shammy with
`cloud` — which is what shipped until the grain weave was fitted — put its
variance at both ends of the band and none in the middle where the nap is, and
at Shammy's contrast that reads as grit over a blotch.

`cloud` also carries an unsharp mask, on the field rather than on the pixels,
and it used to read as a weave rather than as a nap. The cause was the two
settings together: the mask runs at a radius of one cell of the finest octave —
which is exactly the radius that puts a rim on every cell of that octave — and
that octave was split only two ways, so two sets of rims interlocked into a
reticulation. Suede is not woven. The octave now splits five ways, which leaves
no lattice to rim, and the mask comes down from 3.5 to 1.5. Six colours per
product at 234px, before and after: totals fall a quarter to a third (LT
3.79→2.81, LX 8.79→5.90) while what survives a 1.5px blur — the surface rather
than the sparkle — holds on the quieter products (LT 2.00→2.17, ST 2.28→2.31,
DS102 4.68→4.64) and gives up about 12% on the two that carry the library's
highest contrast (Lamous 5.02→4.43, LX 5.06→4.33). For scale, an LT photograph
at the same size keeps only 38% of its variance through that blur; the old tile
kept 49%.

Reading a close-up takes two corrections, both of which the first pass of
`grain` missed and both of which push the same way. It is out of focus outside
the near edge of the fold, and averaging crops across the frame measures the
blur, which reads as coarseness. And a centimetre of cloth in a macro is not a
swatch: cycles across that crop are not cycles across a tile. Taken literally
the first fit drew a 10-pixel feature in a 128-pixel crop as a 10-cycle feature
on a whole swatch, and the result was blobby. The grain band is placed by the
family instead — at the magnification `cloud` is drawn at — which moved it up
by a factor of about 3.2.

Those two corrections move the frequencies and leave the weights, which came
off the same blurred frame and overstate the nap for the same reasons. A third
correction takes the two loud octaves to 0.55 of the fitted weights. It has no
number of its own to move by, so the family settles it: measured on six tiles
at 234px, the part that survives a 1.5px blur — a surface rather than a
sparkle, and the only figure that compares across weaves, since `cloud`'s total
is inflated by a sparkle `grain` does not have — now reads 4.68 for Shammy
against 4.55 for Texvision, 4.05 for Lamous and 2.48 for LT, where at the
fitted weights it was 6.21.

A weave may also spend less than the measured contrast, through `gain`. `grain`
is at 0.65: Shammy's numbers were read off a photographed colour card rather
than off swatch photographs, and they run a median of 13.5 against 2.8–6.7 for
every other product in the library.

An entry may override its product's weave with `nap.weave`, for the day a
product is photographed two ways.

`contrast_source` says how much to trust the number:

| value | |
|---|---|
| `measured` | read off a frame ≥300px. The good case |
| `modeled` | fitted from lightness where no large enough frame exists — LT only |
| `measured-small-frame` | measured under 300px, then the calibrated resolution bias divided out. Carries `contrast_frame_px` and `contrast_res_factor` |
| `measured-small-frame-anchored` | as above, plus a second correction against a properly-sized control. Shammy only; carries `contrast_anchor_factor`, and `meta.nap_anchor` records the comparison |
| `product-constant` | one value for the whole product, measured off the only flat images that exist and given to every colour. DS102 only; `meta.nap_source` records the measurement and why it is not per-colour |

`nap` is `null` where there is nothing to measure. DS102 is the awkward case:
its per-colour photographs are draped fabric, so what varies across those frames
is folds rather than nap — measured both ways, the drapes read 2.18–5.05× the
flat chart. Its shader therefore comes from the one labelled chart in the
listing, as a single `product-constant` shared by all 41.

### Where a DS102 colour is sampled from

DS102's photographs are also the only ones here that are not a swatch, and they
come in two shots: 13 are a flat piece on studio paper with a numbered badge and
the colour name printed over the bottom right, and 28 are the cloth swirled into
a rosette. Each colour records which it is as `shot`. A centre crop — what every
other product uses — would return a badge on the first and whatever fold sits at
the middle on the second, so the hex is instead the median over the flattest
cloth the frame has: 72px windows holding no studio paper and no hard edge (the
badge rim, the printed glyphs, the pinked zigzag), ranked by how little the light
drifts across them, and of the flattest half, the ones nearest the frame's median
fabric luminance. The last clause is what keeps the sample off the lit side of a
fold: measured on the nine colours the chart covers, what comes back sits at the
54th–61st percentile of its own frame's light.

Against the seller's chart this scores the same as the whole-frame median it
replaced — mean RGB distance 27 against 26 — and that is the honest reading,
because the chart's own three rows read 1.03, 1.03 and 1.17 against the
photographs and so cannot resolve a difference this size. What it does fix is
where the number comes from: flat cloth, rather than a statistic over folds, a
printed badge and a shadow. The colours barely move for it — median 5.2 of 441
possible in RGB distance, most of it the 13 flat pieces brightening 2–8% now that
the badge and the name are out of the sample.

### Images

Two sizes, both relative to the repo root:

```
images/<sku>.jpg          small,  ~100px
images/large/<sku>.jpg    large,  418-800px depending on what the source had
```

`image_large` is what the site shows in the detail panel and what colours are
sampled from, so the datasets rebuild reproducibly from what is committed rather
than from whatever the upstream server serves today.

## Adding a product

Each product has one builder in `scraping/`, all the same two-pass shape:

```bash
python3 scraping/build_<product>.py --fetch    # snapshot the source + images
python3 scraping/build_<product>.py            # sample, write ../<product>.json
```

`--fetch` is the only step that touches the network, and it commits its snapshot,
so anyone can rebuild without hitting the source.

Import the measurement from `build_dataset.py` rather than reimplementing it —
`sample_color` (median of a centre crop), `nap`, `nap_small` — so that every
product's hexes and shaders mean the same thing.

Then add the product to `PRODUCTS` in `site/js/demo.js`. The page builds its
sections from whatever the file contains, so a product with only `colors` gets
one grid and nothing empty.

## What these numbers are not

Every hex here is **sampled from a photograph**, not an official manufacturer
colour value. They are approximate, and how approximate varies by product —
`meta.color_note` says, per file. Contrast is also partly a property of the
camera: the two products Toray photographed itself measure 1.4–5.0, while the
same kind of cloth shot by retailers measures 2.5–19.8. Compare within a product
freely; compare across products with that in mind.

## Licence

MIT — see `LICENSE`. Archived photographs belong to their respective owners.
