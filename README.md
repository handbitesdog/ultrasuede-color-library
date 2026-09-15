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
`sample_url`, `in_stock`, `variation_id`, `name_ja`. Consumers should treat
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
