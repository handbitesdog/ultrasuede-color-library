/*
 * Synthetic Suede Fabric Library — the nap shaders.
 *
 * Draws a swatch from its `nap` block instead of its photograph. The photos are
 * 100px thumbnails scraped out of the archive, two of them JPEG mush and
 * thirteen of them stamped with a retailer's watermark; the numbers sampled out
 * of them are cleaner than the pixels are, so the grid is drawn from the
 * numbers.
 *
 * What the numbers say (see meta.nap_note in lt.json, and the nap math in
 * scraping/build_dataset.py, for how they were arrived at):
 *
 *   hex       the median colour of the swatch
 *   axis      the direction the fabric's light-and-dark variation runs through
 *             RGB, normalised so its own luminance is 1
 *   contrast  the standard deviation of that variation, in 0-255 luminance
 *
 * So a pixel is  base + axis * contrast * t,  where t is a unit-variance noise
 * field — additive, not multiplicative, because that is how the variation
 * actually behaves in these photographs. Getting that right is most of the
 * likeness: it is what keeps a highlight on Flash Red from turning pink.
 *
 * Those three numbers say what colour a swatch is and how far it moves. What
 * they do not say is *at what size* it moves, and that turns out not to be one
 * answer across the library — see WEAVES below. A weave is the spectrum: which
 * octaves the field is built from and what each one weighs. Everything else —
 * the base-plus-axis model, the noise, the seeding, the one WebGL context — is
 * shared, because it is the same measurement on every product.
 *
 * One WebGL context does the whole page. A context per swatch would be 240 of
 * them against a browser limit of about 16, so the shaders draw into a single
 * offscreen canvas and each tile keeps a cheap 2-D canvas to blit into. One
 * program per weave, compiled the first time a swatch asks for it.
 */

var Nap = (function () {
    "use strict";

    /*
     * Standard deviation of one octave of quintic-interpolated value noise over
     * a uniform hash.
     */
    var NOISE_SD = 0.2247;

    /*
     * Rotations, one per noise layer, so no two lattices ever line up. They are
     * irrational fractions of a turn, so they do not agree with each other
     * either. The list has to be at least as long as the busiest weave.
     */
    var ROT = [0.358, 1.068, -0.680, 1.700, 2.443, 0.912, -1.235,
               0.271, -1.902, 2.117, 0.644, -0.417];

    /*
     * Everything is drawn at this size and scaled down to whatever the caller
     * asked for, rather than drawn at the asked-for size directly — so a tile
     * and the popover's large view are the same fabric at two magnifications
     * rather than two different fabrics.
     *
     * 512 carries the finest octave with room to spare, and the popover shows
     * the frame at about 524 device pixels, so what is drawn is what is
     * displayed. Rendering larger was tried and measured — at 1024 and at 2048
     * the fine band at display size came out 0.481x and 0.478x against 512's
     * 0.483x, which is to say identical and then slightly worse. The softness
     * was never the raster.
     */
    var RENDER_PX = 512;

    /* ---- the weaves --------------------------------------------------------
     *
     * A weave is one fabric's spectrum: the octaves its light-and-dark
     * variation decomposes into, as cycles across the frame, and how much of
     * `contrast` each one draws. Two of them so far, and they are variations on
     * one shape rather than two shapes — these are all the same kind of cloth,
     * and unless something is measured to differ they should look like it.
     *
     * `cloud` is Ultrasuede, measured off the archive's photographs. Nearly
     * half of its structural variance is broad — slower than three cycles — and
     * what is fine is a thin mottle sitting on top of it. A swatch reads as a
     * soft cloudy field with a tooth.
     *
     * `grain` is Shammy 707J, from the seller's own 678x445 close-up
     * (colorcards/shammy_707j_closeup.jpg — the only picture in the library
     * that shows this cloth at a size where its texture is resolved). Same
     * broad field, same sheen; the nap is denser and more even, and it is the
     * middle of the band that carries it. As a share of variance, in cycles
     * across the frame — the ensemble-mean power spectrum over 96 frames,
     * which is what the 0-4 band needs before it settles, since three cycles
     * across a frame realise wildly different variance frame to frame:
     *
     *     cycles     0-4  4-32  32+
     *     cloud     30.2   5.8  65.3
     *     grain     34.5  18.5  48.5
     *
     * The two now share a broad end and part in the middle, which is the whole
     * of what distinguishes them: 18.5% against 5.8% at 4-32 cycles is a dense
     * even grain against a thin mottle.
     *
     * Drawing Shammy with `cloud` — which is what this file used to do for
     * every product — put the energy at both ends of the band and nothing in
     * the middle where the nap actually is. At Shammy's contrast, three to four
     * times Ultrasuede's, that reads as sparkling grit over a blotch.
     *
     * Each weave's fields, and how they were arrived at:
     *
     *   octaves   frequency in cycles across the frame, and weight. `split`
     *             draws the octave as several layers at those ratios of its
     *             frequency, each at its own angle, at 1/sqrt(n) the weight so
     *             the pair or the triple carries the variance of one.
     *   sharpen   how much of the difference between the field and a blur of it
     *             to add back, and 0 for none.
     *   gain      what share of the measured contrast to draw, default 1. Not
     *             a taste dial: it is for a product whose numbers came by a
     *             route known to inflate them.
     *   sheen     the share of contrast spent on a smooth ramp instead of on
     *             noise. The octaves are scaled by the remainder, so the two
     *             combine in quadrature rather than one being added on top of a
     *             field that was already the right size.
     *
     * The direction of the ramp is deliberately the same for every swatch and
     * both weaves: consistent raking light looks like a lighting set-up, varied
     * light looks like a bug.
     */
    var SHEEN_DIR = [0.62, -0.78];

    var WEAVES = {
        /*
         * Ultrasuede — LT, LX, ST, Lamous TH, Texvision DS102.
         *
         * There is no octave finer than 100 cycles in the measurement, and that
         * is the whole difference between cloth and tyre tread. Measured raw,
         * 80% of a swatch's variance sits in a pixel-scale band — but that
         * band's horizontal lag-1 autocorrelation is *negative*, which is the
         * signature of sensor and JPEG noise rather than of a surface. Drawing
         * a camera's noise budget as a coherent noise field is what made an
         * earlier pass of this shader read as sharp directional streaks. It is
         * measured out and not drawn.
         *
         * What is left is broad and gentle: of the structural variation, a fine
         * mottle at 100 cycles carries 45% and a cloud slower than 3 carries
         * 36%, with a thin tail between (NAP_WEIGHTS in build_dataset.py).
         *
         * These are not quite those numbers. Three things are folded in that
         * only show up once the field is actually drawn: a three-cycle octave
         * realises noticeably less variance inside any one frame than its
         * ensemble variance, so the broad end is worth more here than the
         * spectrum says; the sheen takes a share; and the finest octave sits at
         * 180 cycles rather than the measured 100. That last one is the only
         * place this deliberately leaves the measurement — at 100 cycles the
         * mottle is a five-pixel cell, and a swatch whose smallest feature is
         * five pixels reads as low resolution however hard it is sharpened.
         * Rendered against all 30 large captures the move takes the fine band
         * from 0.48x to 0.77x of the photographs and the structural band from
         * 1.13x to 0.97x — closer on both. Those two ratios were measured with
         * the unsharp mask at 3.5 and have not been remeasured since it came
         * down to 1.5; they are about where the octave sits, which has not
         * changed, and the fine one will now read lower.
         */
        cloud: {
            label: "cloud",
            octaves: [
                { freq: 180, weight: 0.4155,
                  split: [1.0, 1.13, 1.31, 1.52, 1.77] },
                { freq: 40, weight: 0.2001 },
                { freq: 17, weight: 0.1346 },
                { freq: 7, weight: 0.1451 },
                { freq: 3, weight: 0.7495, split: [1.0, 1.31] }
            ],
            /*
             * An unsharp mask, on the field rather than on the pixels — the
             * field is drawn at RENDER_PX and scaled twice on its way to the
             * screen, and the photographs go through neither of those blurs.
             *
             * It used to be 3.5, and the two changes here are one change: the
             * mask ran at a radius of one cell of the finest octave, which is
             * exactly the radius that puts a rim on every cell of that octave,
             * and with the octave split only two ways those rims interlocked
             * into a reticulation that read as woven. Suede is not woven. The
             * five-way split breaks the lattice and the smaller mask stops
             * drawing its outline.
             *
             * Two of the five layers sit above RENDER_PX's Nyquist — 273.6 and
             * 318.6 cycles against 256 — so they alias rather than resolve.
             * Measured against a split with the same spread kept under it
             * (1.0-1.375, top layer 247.5), the whole of the difference at
             * display size is sd 42.4 against 43.4 and two points of band
             * share moving from 32+ into 0-4. It is small enough to leave, and
             * it is written down so it is not rediscovered as a mystery.
             *
             * What made this safe to do is that most of what the mask was
             * adding did not survive a blur — it was sparkle, not surface.
             * Six colours per product spread across the lightness range, drawn
             * at 234px and trimmed 12px, measured before and after:
             *
             *                   total         after a 1.5px blur
             *     LT         3.79 -> 2.81        2.00 -> 2.17
             *     ST         3.97 -> 2.93        2.28 -> 2.31
             *     DS102      8.04 -> 5.91        4.68 -> 4.64
             *     Lamous     8.40 -> 5.80        5.02 -> 4.43
             *     LX         8.79 -> 5.90        5.06 -> 4.33
             *
             * Totals fall by a quarter to a third; the surface is untouched on
             * the three quieter products and does lose about 12% on Lamous and
             * LX, which carry the highest contrast in the library and so had
             * the most rim to lose. That is the honest cost, and it is worth
             * paying: of an LT photograph's own variance only 38% survives the
             * same blur, against 49% of the old tile's, which is the
             * measurement agreeing with the eye that ours had structure where
             * the photograph has dust.
             */
            sharpen: 1.5,
            /*
             * Noise alone comes out at 0.77 of the photographs' broad band, and
             * the shortfall is not an error in the weights — it is a smooth
             * gradient across the frame, the studio's raking light, which no
             * amount of noise makes. An orthogonal component of 0.64 of that
             * band closes the gap, and 0.64 of a band that is itself 0.61 of
             * the total is this number.
             */
            sheen: 0.394,
            /*
             * What one unit of `contrast` actually comes out as, once the
             * octaves, the sheen, the mask and `gain` have all had their turn:
             * the luminance sd of a finished tile at 234px with 12px of the
             * frame edge trimmed off, divided by the number that went in.
             * Measured over every colour of every product on this weave, where
             * it lands at 1.00 — the unsharp mask puts back about what the
             * downsample takes out. See `tame` below, which is the only thing
             * that reads it.
             */
            drawn: 1.0
        },

        /*
         * Shammy 707J.
         *
         * Same architecture as `cloud` — a broad field, a thin middle, a fine
         * nap on top — with the weight moved onto the nap and the nap moved up
         * an octave and a half. Shammy is a denser, more even grain than
         * Ultrasuede's thin mottle, and that is the whole of the difference
         * between the two weaves. They are the same kind of cloth photographed
         * at the same magnification, so they belong on the same scale.
         *
         * The spectrum came from the seller's 678x445 close-up
         * (colorcards/shammy_707j_closeup.jpg), which is the only picture in
         * the library that resolves this cloth at all — but it is a macro of
         * draped fabric, and reading it needs two corrections that the first
         * pass of this weave did not make.
         *
         * It is out of focus everywhere but the left of the fold. Scanning
         * every 128px crop for gradient-over-sd, the sharpest sit around
         * x 160-224, y 230-262 at 0.62, and the right-hand third runs 0.20-0.26
         * — the same cloth through three times less lens. Crops averaged across
         * the frame measure the blur, and blur reads as coarseness.
         *
         * And the crop is not a swatch. A tile here stands for a piece of cloth
         * about the size the archive's photographs show; the sharp part of this
         * close-up is a centimetre or so of it. Cycles across that crop are not
         * cycles across a tile, and taking one for the other is what made the
         * first pass read as blobby porridge: measured, its grain peaked at a
         * 10px period in a 128px crop, which was drawn as a 10-cycle feature on
         * a whole swatch.
         *
         * Both corrections push the same way, so the grain band is placed by
         * the family instead: at the magnification `cloud` is drawn at, where
         * Ultrasuede's fine mottle sits at 180 cycles with a layer at 236. The
         * three grain octaves keep the frequency ratios the fit gave them and
         * move up together by a factor of about 3.2, to 186 / 120 / 50. The two
         * octaves below them are `cloud`'s own, at about half its weight on the
         * broad one: a crop that small cannot see a swatch-wide cloud at all —
         * what looks like broad variation in it is the shading of a fold — so
         * the broad end cannot be measured here and is inherited rather than
         * invented.
         *
         * The weights on the two loud octaves are then 0.55 of what the fit
         * gave (0.3913 and 0.8586, now 0.2152 and 0.4722). This is the third
         * correction of the same species as the other two: focus and
         * magnification both say the close-up overstates this grain, and
         * neither of them touches the weights, which were fitted from the same
         * blurred frame. Unlike those two it has no number of its own to move
         * by, so what settles it is the family. Measured on six tiles at 234px,
         * the part of a tile that survives a 1.5px blur — the part that is a
         * surface rather than a sparkle:
         *
         *     Shammy, fitted weights        6.21   (at the 0.80 gain below)
         *     Shammy, as drawn now          4.68
         *     Texvision DS102               4.55
         *     Lamous TH                     4.05
         *     Ultrasuede LT                 2.48
         *
         * which puts it at the top of the family rather than outside it, and
         * that is the most the close-up supports: it shows a denser and more
         * even grain than Ultrasuede's, not a louder cloth.
         *
         * Going finer instead of quieter does not work, and the check is the
         * autocorrelation at tile size, where a scale the tile cannot resolve
         * shows up as smoothness. Past about 120 cycles the extra fineness is
         * averaged away in the downsample and lag-1 climbs back: +0.67 at the
         * band as placed, +0.72 at 180, +0.76 at 210.
         *
         * What that lands on, as a share of variance over 96 frames, with
         * `cloud` and the fitted weights beside it:
         *
         *     cycles       0-4  4-32  32+
         *     grain       34.5  18.5  48.5
         *     as fitted   14.7  19.7  66.2
         *     cloud       30.2   5.8  65.3
         *
         * The broad end has not grown — it is untouched, and only looks larger
         * because the nap above it fell. Read the other way: holding the broad
         * octave fixed, its share going 14.7% to 34.5% says the total variance
         * fell to 42% of what the fitted weights drew, which is the sd falling
         * to 0.65x, and that is the change. The 4-32 band is still where these
         * two weaves actually part: that is the middle scale `cloud` barely
         * has, and it is what makes Shammy read as a denser, more even grain
         * rather than as a thin mottle.
         *
         * `cloud`'s own row moved at the same time and for the same kind of
         * reason — its mask came down from 3.5 to 1.5, which was amplifying the
         * 32+ band and nothing else. It was 11.8 / 3.4 / 85.4 before that.
         *
         * No sharpening, and this is the one place the weaves genuinely differ
         * in kind. On `cloud` the mask has a starved octave to lift. Here the
         * grain is the thing being asked to sit down, and the mask only moves
         * it up into the raster: at 1.5 the 64-128 band goes from 33% to 57%,
         * and by 3.5 the swatch is sand.
         *
         * Sheen is `cloud`'s, for the same reason the broad octave is — a flat
         * swatch under one distant light is a flat swatch under one distant
         * light, whatever the cloth.
         */
        grain: {
            label: "grain",
            octaves: [
                { freq: 186, weight: 0.2152, split: [1.0, 1.27] },
                { freq: 120, weight: 0.4722, split: [1.0, 1.19, 1.47] },
                { freq: 50, weight: 0.1364, split: [1.0, 1.19, 1.47] },
                { freq: 17, weight: 0.13 },
                { freq: 3, weight: 0.35, split: [1.0, 1.31] }
            ],
            sharpen: 0,
            sheen: 0.394,
            /*
             * Shammy's per-colour contrast is the odd number in the library:
             * a median of 13.5 against 3.1 for LT, 2.8 for ST, 5.7 for DS102
             * and 6.1 for Lamous. It is not the cloth — the close-up measures
             * 13.6 over a centimetre of it, and it is the same kind of suede as
             * the rest — it is that these numbers were read off a photographed
             * colour card rather than off photographs of swatches, and that
             * card's darks are also where the contrast runs highest (r = -0.97
             * against lightness, which is backwards for every other product).
             *
             * Drawn at the fitted weights with no gain at all, six Shammy
             * tiles across the lightness range average a luminance sd of 11.96
             * at 234px, against 4.28 for LT, 7.80 for Lamous and 7.98 for
             * Texvision. The weights above take the nap down; this takes what
             * is left down with it, to 5.95 — below the rest of the family on
             * the total, and at the top of it on the structural figure in the
             * table above, which is the right way round for a weave with no
             * unsharp mask to add a sparkle the others have. This is still a
             * nudge rather than a fix — the direction the card's own error runs
             * is untouched and still open.
             */
            gain: 0.65,
            /*
             * `cloud`'s note applies; the number does not. This weave draws no
             * unsharp mask and carries the 0.65 above, and between them a unit
             * of `contrast` arrives as 0.42 of one — measured the same way,
             * over all 42 Shammy colours. It is why Shammy's contrast column
             * reads three times the rest of the library's and its tiles do not
             * look three times as loud, and why `tame` has to work in what is
             * drawn rather than in what the file says.
             */
            drawn: 0.42
        }
    };

    var DEFAULT_WEAVE = "cloud";

    /*
     * Which weave draws an entry. The product decides — it is a property of the
     * cloth, not of the colour — but an entry may override it, because a
     * product photographed two ways is two different measurements and the day
     * that happens the record should be able to say so.
     */
    function weaveOf(entry, fallback) {
        var name = (entry && entry.nap && entry.nap.weave) || fallback ||
            DEFAULT_WEAVE;
        return WEAVES[name] ? name : DEFAULT_WEAVE;
    }

    /* ---- what the camera did ------------------------------------------------
     *
     * Two corrections live here, for the two products whose photographs were
     * taken in a way the measurement cannot see past: LX was lit harder than
     * anything else on this page, and Lamous was shot closer. Both correct a
     * measurement rather than a taste, both are one number arrived at by
     * measuring, and both run before `tame`, because the knee is a scale for
     * the page and should be shown what a product is rather than what its
     * capture said about it. Neither touches a product file.
     *
     * LX's photographs are lit harder than anything else on this page, and a
     * measurement cannot tell a hard light from a loud cloth. Fitting the
     * family's own contrast curve — NAP_FIT in build_dataset.py,
     * contrast = A * x^0.65 * (1 - x)^0.50 for x = L/255 — to each product's
     * measured colours and reading off the amplitude:
     *
     *     LT      8.03      LX      23.99
     *     ST      7.42      Lamous  16.41
     *
     * (Lamous's 16.41 is read off close-ups and has its own correction below;
     * it is in the table because it is one of the five colours' worth of
     * evidence the curve's shape was fitted on, not as a comparison.)
     *
     * LT and ST were photographed by different people years apart and agree to
     * 8%, which is the whole reason they are the reference. LX is three times
     * either of them at the same lightness, and its colours still lie along
     * the curve's shape (R2 0.53) — it has the family's relation between
     * lightness and contrast, lifted bodily.
     *
     * Three things say that lift is the studio and not the suede.
     *
     * It is flat across the spectrum. LX against ST band by band, in the five
     * bands nap_contrast measures, as a ratio of sd: 3.19, 3.29, 2.62, 2.59,
     * 2.74, and 3.03 on the total. That is one number, not a shape — the same
     * nap under a harder light. Something that genuinely differed would move
     * one band and leave the others — which is what Shammy does, and why
     * Shammy got a weave rather than this, and what Lamous does for a third
     * reason again, `closeup` below.
     *
     * It is not resolution. NAP_RES_CALIBRATION puts a 256px frame at 0.993 of
     * native, and the LX frames that carry a measurement are 397px and 800px
     * against ST's 418px. There is no factor of three anywhere in that.
     *
     * And it only ever adds. All 25 LX colours sit at or above the family
     * curve — White at 1.04x, Ginger at 4.79x, none of them below. Cloth that
     * really varied would scatter to both sides of the curve; an error that
     * has a sign is the capture.
     *
     * So LX is pulled back toward the curve:
     *
     *     drawn = model(L) * (measured / model(L)) ^ keep
     *
     * which is a gain in the log of that ratio rather than in the contrast,
     * and the difference is the point. A flat per-product gain is what `tame`
     * below argues against, and correctly: LX's White, Blue and Turquoise
     * measure 1.04x, 1.12x and 1.16x of the curve — they are already in LT and
     * ST's band — and a gain chosen to fix the median would take them to flat
     * paint. Here a colour sitting on the curve does not move at all, whatever
     * `keep` is, and only the inflated ones come down. White goes 2.72 to 2.65
     * and Ginger 16.82 to 5.61.
     *
     * The map is monotonic, so the order survives: Ginger is still the loudest
     * LX colour and Black still the quietest.
     *
     * `keep` is one number with an honest meaning at both ends — 1 is the
     * measurement untouched, 0 is the family curve with none of LX's own
     * colour-to-colour variation left. At 0.30 the median LX swatch draws at
     * 3.22 against LT's 3.02 and ST's 2.82, over a range of 1.94 to 4.55
     * against LT's 1.51 to 4.21 — the reference band almost exactly, with the
     * loud colours still reading as the loud ones. It was set by eye against
     * LT and ST at 0.3, 0.4 and 0.5; 0.4 also sits inside the band and reads
     * a little livelier, and is the number to go back to if this is ever
     * judged to have taken too much.
     *
     * The cost is the one `tame` names, and it is real: whatever part of LX's
     * spread is the cloth rather than the lighting has been squeezed along
     * with the rest, and nothing here can separate them. What this does not do
     * is touch the file. lx.json keeps every number exactly as it was sampled,
     * and this and `tame` remain the only two places they are bent.
     *
     * This runs before `tame`, because it is a correction to a measurement and
     * the knee is a scale for the page — the knee should be shown what LX
     * actually is rather than what its lighting said.
     */
    var LUMA = [0.2126, 0.7152, 0.0722];

    /* The family's curve, and the lightness window it was fitted over: read
     * inside that window and held flat outside it, as build_dataset.py reads
     * it, rather than extrapolated to the ends where it goes to zero. */
    var FAMILY = { a: 8.02, p: 0.65, q: 0.50,
                   lo: 25.07 / 255, hi: 240.69 / 255 };

    function familyContrast(rgb) {
        var x = (rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2]) / 255;
        x = Math.min(Math.max(x, FAMILY.lo), FAMILY.hi);
        return FAMILY.a * Math.pow(x, FAMILY.p) * Math.pow(1 - x, FAMILY.q);
    }

    /*
     * `keep` undefined is a product whose lighting is not in question, which is
     * every product but LX, and it is left alone rather than run through a
     * no-op — the curve is a fit to five products and does not belong anywhere
     * near a number it was not asked about.
     */
    function flatten(contrast, rgb, keep) {
        if (keep === undefined || keep >= 1 || !rgb) { return contrast; }
        var m = familyContrast(rgb);
        if (!(m > 0) || !(contrast > 0)) { return contrast; }
        return m * Math.pow(contrast / m, keep);
    }

    /*
     * Lamous's photographs are close-ups. Every other product here is a swatch
     * photographed whole; Lamous's 49 frames are filled edge to edge with
     * resolved fibre, and the difference is a factor of about 2.6 in how much
     * cloth is inside the frame.
     *
     * That factor is measured twice, two ways, and the two agree. Aligning
     * ensemble power spectra — each product's frames blurred by NAP_NOISE,
     * radially binned in cycles across the frame width, one slid against the
     * other in log frequency until the shapes match — the three Ultrasuede
     * sets agree with each other to within the spread of their own framing,
     * and Lamous does not:
     *
     *                vs LT   vs ST   vs LX     fit error
     *     LT            --    1.14    1.38     0.11-0.15
     *     ST          0.87      --    1.19     0.12-0.13
     *     LX          0.79    0.90      --     0.15-0.26
     *     Lamous      2.48    2.68    3.41     0.10-0.11
     *
     * Lamous's are the lowest fit errors in the table, which is to say it is
     * the same spectrum as the others and the offset is well determined. And
     * re-measuring Lamous with build_dataset's five bands scaled by 2.6, so
     * that each band covers the same physical scale of cloth it covers on an
     * archive photograph, against the mean of LT and ST band by band:
     *
     *                  <2px   2-5   5-12  12-30  broad   spread
     *     as shot      1.65  3.52   2.76   1.87   1.56     1.87
     *     bands x2.6   1.45  1.57   1.64   1.78   1.40     0.38
     *
     * The excess stops being a shape and becomes a level, and the flattening
     * is deepest at 2.4-2.6, which is where the spectra put it too. That is
     * the LX test run backwards: LX was flat across the bands from the start,
     * which is what a light does, and Lamous was not, which is why this is a
     * different correction rather than `flatten` with a different number.
     *
     * What to draw is then the ratio of the re-measured contrast to the
     * file's: a median of 0.718 over the 49 colours, standard deviation 0.082,
     * and no relation to lightness at all (r = -0.08). One number is the right
     * shape for it — this is a property of the camera, not of the colour.
     * Where LX's ratio to the family curve ran from 1.04 to 4.79 across its
     * colours, and so had to be worked in the log of that ratio or its quiet
     * end would have gone to flat paint, there is nothing here for a
     * per-colour correction to do.
     *
     * What is left is not removed. At the same physical scales Lamous still
     * measures about 1.55x LT and ST across all five bands, and that is either
     * a denser cloth or another studio's light; nothing here separates them,
     * and it is a small enough difference between two manufacturers' suede to
     * leave alone. Lamous is not Ultrasuede and is allowed to be a louder
     * cloth than it.
     *
     * The one reading this cannot rule out is that Lamous is a coarser cloth
     * photographed at everyone else's magnification, which would look the same
     * in every number above. Against it: the family premise WEAVES opens with,
     * that a 2.6x coarser nap would be a different kind of suede from a
     * manufacturer selling the same kind, and the frames themselves — shown at
     * 1/2.6 Lamous's nap reads as the fine even mottle LT and ST show, and at
     * full size it reads as clumps.
     *
     * Median drawn tile 4.74 to 3.93, over 1.79-5.12 against 2.48-5.82, which
     * puts it under DS102 and Shammy at 4.58 and 4.57 instead of above them.
     * The spectrum is unchanged, so the weave is: Lamous is `cloud`, and after
     * this that is a finding rather than a default.
     */
    function closeup(contrast, share) {
        if (share === undefined || share >= 1) { return contrast; }
        return contrast * share;
    }

    /* ---- one scale for the library -----------------------------------------
     *
     * Six products sit on this page next to each other, and their `contrast`
     * numbers were read off six different sets of pictures: LT and ST off the
     * archive's 100px thumbnails, LX off a sales catalogue running 397px to
     * 3667px, Lamous off small frames, Shammy off a photographed colour card,
     * DS102 off one sample of flat cloth. Each set is internally consistent and
     * no two of them are consistent with each other — a thumbnail has had its
     * fine variation averaged out of it before anything was measured, and a
     * 3667px catalogue shot has not. Drawn as they stand, the median tile:
     *
     *     LT     3.18      Lamous    6.13
     *     ST     2.66      Shammy    5.73
     *     LX     6.58      DS102     5.46
     *
     * — luminance sd at 234px, frame edge trimmed, over every colour of each
     * product. Four products at roughly twice the other two, and LX's loudest
     * colours at five times them. That spread is the capture, not the cloth:
     * these are all the same kind of suede, and Shammy's own close-up measures
     * it at the same magnification as Ultrasuede's.
     *
     * So the page needs one scale. The obvious way to get one is a gain per
     * product, and it is the wrong way, because the disagreement is not spread
     * evenly across a product's colours. Every product's quiet end is already
     * in LT and ST's band — LX's Black draws at 2.88, Shammy's Yellow at 2.12,
     * Lamous's TH001 at 2.17 — and a proportional cut takes those below it,
     * to 1.39, 1.17 and 1.14, which is flat paint rather than suede. The
     * products only part company at the loud end, so that is the only place a
     * correction belongs.
     *
     * Hence a knee: below KNEE nothing moves at all, and above it the excess
     * is divided by how far past it has come, so the curve flattens toward
     * KNEE + ROOM and never reaches it. What that lands on, median and max:
     *
     *                before          after
     *     LT      3.18 (4.7)     3.11 (4.1)
     *     ST      2.66 (5.3)     2.62 (4.5)
     *     LX      6.58 (16.4)    4.88 (7.1)
     *     Lamous  6.13 (9.9)     4.80 (6.2)
     *     Shammy  5.73 (8.2)     4.54 (6.0)
     *     DS102   5.46 (8.1)     4.40 (6.5)
     *
     * LT and ST are the reference and come through untouched but for their few
     * loudest colours; the other four lose about a quarter of their median and
     * more than half of their worst.
     *
     * The cost, which is real: at the loud end this throws away differences
     * between colours. LX's Citron and Ginger measure 9.69 and 16.50 and now
     * draw at 6.13 and 6.61, which is to say the same. If that difference is
     * the cloth rather than the catalogue's lighting, it has been lost, and
     * nothing here can tell which — LX's contrast correlates with lightness at
     * r = 0.53, which is what a photograph does and also what a surface does.
     * It is worth noting that this is a scale for the page and not a
     * correction to the measurement: the product files keep their sampled
     * numbers exactly as sampled, and this is the only place they are bent.
     *
     * Distinct from a weave's `gain`, which is one fabric's number being
     * distrusted. This is six fabrics' numbers being put on one axis.
     *
     * The LX and Lamous rows above are no longer what the page draws. Both
     * arrive here already corrected for their capture — see `flatten` and
     * `closeup` — so the knee is handed a median of 3.31 rather than 6.58 for
     * LX and 4.38 rather than 6.13 for Lamous, and has much less left to do:
     * 3.22 and 3.93 out, against the 4.88 and 4.80 in that table. The rows are
     * kept as they were measured, because they are what the knee alone does
     * and that is what they are here to describe.
     *
     * Lamous's correction is the proportional cut this section argues against,
     * and the argument stands — it is an argument against choosing one to make
     * the page agree, which would have to be about 0.5 and would take TH001
     * from 2.17 to 1.14. Lamous's 0.72 is not chosen to make anything agree.
     * It is the measured ratio between its frames and everyone else's, it is
     * the same ratio for every colour it has, and it leaves TH001 at 1.79,
     * inside LT's own 1.51 to 4.21. A proportional cut is wrong here when it
     * is a page scale and right when the thing being corrected is proportional.
     */
    var KNEE = 2.5;
    var ROOM = 6.0;

    /*
     * The knee, applied to what a swatch draws as rather than to the number in
     * the file — `drawn` converts each way. A weave that draws a unit of
     * contrast as less than one (grain, at 0.42) would otherwise be compressed
     * as though it were louder than it looks, which is backwards.
     */
    function tame(contrast, weaveName) {
        var d = WEAVES[weaveName].drawn;
        var s = contrast * d;
        if (s <= KNEE) { return contrast; }
        return (KNEE + (s - KNEE) / (1 + (s - KNEE) / ROOM)) / d;
    }

    function mat2(a) {
        var c = Math.cos(a), s = Math.sin(a);
        return "mat2(" + [c, s, -s, c].map(function (v) {
            return v.toFixed(4);
        }).join(", ") + ")";
    }

    var VERT = [
        "attribute vec2 aPos;",
        "varying vec2 vUv;",
        "void main() {",
        "    vUv = aPos * 0.5 + 0.5;",
        "    gl_Position = vec4(aPos, 0.0, 1.0);",
        "}"
    ].join("\n");

    /*
     * The octave sum, written out from a weave's `octaves`. Every layer takes
     * its own offset from the seed rather than sharing an origin, so no two
     * swatches line up and no octave pins its features to the same corner of
     * every tile.
     *
     * A split octave is drawn as several layers at incommensurate frequencies
     * and different angles, at 1/sqrt(n) the weight so the group carries the
     * variance of one. `cloud` splits both ends of its spectrum for opposite
     * reasons — the finest is the one octave where a single lattice would still
     * be legible however it is turned, and the broadest lays only three cells
     * across the frame, few enough that one layer's cell corners would show as
     * the shape of the cloud. `grain` splits its two loudest octaves three ways
     * because the grain is the whole of what that fabric looks like, and a
     * pair is not enough to hide its own lattice when one band carries the
     * look: two layers line the cells up into a diagonal crosshatch, which is
     * the one thing a suede must not be.
     *
     * `cloud`'s finest goes five ways for the same reason `grain`'s go three,
     * arrived at the other way round. A pair there did not crosshatch, because
     * the unsharp mask above it was rimming each layer's cells separately and
     * the two sets of rims interlocked into something that read as a weave.
     * Five layers have no lattice left to rim. See `sharpen` below: the mask
     * came down at the same time, and the two are one change.
     */
    function octaveSum(weave) {
        var rot = 0;
        var lines = weave.octaves.map(function (o, i) {
            function layer(freq) {
                var n = rot;
                rot += 1;
                /* .yx on alternate layers so no two share an offset either */
                return "vnoise(" + mat2(ROT[n % ROT.length]) + " * p * " +
                    freq.toFixed(1) + " + uSeed" + (n % 2 ? ".yx" : "") + " * " +
                    (1.0 + n * 0.7).toFixed(1) + ")";
            }
            var ratios = o.split || [1.0];
            var term = ratios.map(function (r) {
                return layer(o.freq * r);
            }).join("\n            + ");
            if (ratios.length > 1) {
                term = (1 / Math.sqrt(ratios.length)).toFixed(4) +
                    " * (" + term + ")";
            }
            return "        " + (i ? "+ " : "  ") + o.weight.toFixed(4) +
                " * " + term;
        });
        return "    return (\n" + lines.join("\n") + "\n    ) / " +
            NOISE_SD.toFixed(4) + ";";
    }

    /*
     * Everything below the four inputs, for one weave. Kept apart from them
     * because the page and the copyable listing differ only in how those four
     * arrive: the live program takes them as uniforms, and a copied shader has
     * them baked in as constants. One body, so the code on the clipboard is the
     * code that drew the swatch the reader is looking at rather than a
     * paraphrase of it.
     */
    function body(weave) {
        /*
         * The unsharp mask's radius: one cell of the finest octave, expressed
         * in UV rather than in pixels so it follows that octave rather than the
         * raster — the mask has to sit on the scale the field actually has
         * content at, and if it were pinned to a pixel count it would drift off
         * that scale the moment either number changed. The octave's own
         * frequency, not its split layers': the group is that octave, drawn
         * three ways.
         */
        var finest = weave.octaves.reduce(function (hi, o) {
            return Math.max(hi, o.freq);
        }, 1);
        var sharpenR = (1.0 / finest).toFixed(6);

        /*
         * What share of the measured contrast this weave actually draws. One
         * for everything measured off its own fabric's photographs; less where
         * the number arrived by a route that is known to inflate it, which so
         * far is Shammy's colour card. See `gain` in WEAVES.
         */
        var gain = weave.gain === undefined ? 1 : weave.gain;

        var lines = [
            "float hash(vec2 p) {",
            "    p = fract(p * vec2(127.317, 311.7));",
            "    p += dot(p, p + 34.71);",
            "    return fract(p.x * p.y);",
            "}",
            "",
            /*
             * Value noise, centred on zero. The interpolant is quintic rather
             * than the usual smoothstep: smoothstep leaves a kink in the first
             * derivative at every cell boundary, and a field of those kinks
             * lines up into a visible square lattice — which on a fabric swatch
             * reads unmistakably as a woven crosshatch. Suede is not woven. The
             * quintic is flat to the second derivative at the boundary and it
             * goes away.
             */
            "float vnoise(vec2 p) {",
            "    vec2 i = floor(p);",
            "    vec2 f = fract(p);",
            "    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);",
            "    float a = hash(i);",
            "    float b = hash(i + vec2(1.0, 0.0));",
            "    float c = hash(i + vec2(0.0, 1.0));",
            "    float d = hash(i + vec2(1.0, 1.0));",
            "    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) - 0.5;",
            "}",
            "",
            /*
             * No directional stretch, on either weave. Ultrasuede is isotropic
             * from 2px up to within a few percent; the 19% anisotropy an
             * earlier pass stretched the whole field by belonged to the
             * discarded noise band, which is to say to JPEG rather than to the
             * nap. Shammy's close-up looks anisotropic until the crops are
             * squared off — the vertical stretch was the crop's own aspect,
             * resampled; on square crops the two directions agree to 10% and
             * swap sign between crops.
             */
            "float field(vec2 p) {",
            octaveSum(weave),
            "}",
            "",
            "void main() {",
            "    float t = field(vUv);"
        ];

        if (weave.sharpen) {
            lines = lines.concat([
                /*
                 * An unsharp mask, on the field rather than on the pixels.
                 * Sampling the four neighbours costs four more evaluations of
                 * the field, which is nothing on a GPU and is why this is here
                 * rather than as a convolution over the finished pixels — the
                 * same mask written in JS took 680ms to fill the grid. The
                 * radius is the finest octave's own cell size, expressed in UV
                 * rather than in pixels so it follows that octave rather than
                 * the raster.
                 */
                "    float lo = 0.25 * (field(vUv + vec2(" + sharpenR + ", 0.0))",
                "                     + field(vUv - vec2(" + sharpenR + ", 0.0))",
                "                     + field(vUv + vec2(0.0, " + sharpenR + "))",
                "                     + field(vUv - vec2(0.0, " + sharpenR + ")));",
                "    t += " + weave.sharpen.toFixed(2) + " * (t - lo);"
            ]);
        }

        return lines.concat([
            "",
            /*
             * A plain ramp, because that is what a distant source looks like
             * across a swatch this size. Dotted with a unit direction over the
             * unit square it has a standard deviation of 1/sqrt(12), so scaling
             * by sqrt(12) leaves it at unit variance like `t` — and the two
             * coefficients then combine in quadrature to exactly 1.
             */
            "    float sheen = dot(vUv - 0.5, vec2(" + SHEEN_DIR[0].toFixed(2) +
                ", " + SHEEN_DIR[1].toFixed(2) + ")) * 3.4641;",
            "",
            "    vec3 c = uBase + uAxis * uContrast" +
                (gain === 1 ? "" : " * " + gain.toFixed(2) +
                    "  // of the measured sd") +
                (gain === 1 ? " * (t * " : "\n        * (t * ") +
                Math.sqrt(1 - weave.sheen * weave.sheen).toFixed(4) +
                " + sheen * " + weave.sheen.toFixed(3) + ");",
            "    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);",
            "}"
        ]).join("\n");
    }

    var PREAMBLE = [
        "precision highp float;",
        "",
        "varying vec2 vUv;"
    ].join("\n");

    var UNIFORMS = [
        "uniform vec3 uBase;         // the swatch's median colour, 0-1",
        "uniform vec3 uAxis;         // luminance-normalised RGB direction",
        "uniform float uContrast;    // standard deviation, 0-1",
        "uniform vec2 uSeed;"
    ].join("\n");

    /* ---- the one context ---------------------------------------------------
     *
     * Built on first use and never torn down: whichever swatch asks first pays
     * for the compile of its weave, and every other swatch on that weave draws
     * for the cost of four uniform uploads. preserveDrawingBuffer, because
     * every draw here exists to be read straight back out with drawImage.
     */

    var gl = null;
    var programs = {};
    var ready = false;
    var tried = false;

    function compile(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(s));
        }
        return s;
    }

    function init() {
        tried = true;
        try {
            var canvas = document.createElement("canvas");
            canvas.width = RENDER_PX;
            canvas.height = RENDER_PX;
            gl = canvas.getContext("webgl", {
                alpha: false,
                antialias: false,
                depth: false,
                preserveDrawingBuffer: true
            });
            if (!gl) { return false; }

            /* one triangle, big enough to cover the frame */
            var buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.viewport(0, 0, RENDER_PX, RENDER_PX);

            ready = true;
            return true;
        } catch (e) {
            gl = null;
            return false;
        }
    }

    /*
     * The program for one weave, compiled the first time it is asked for. A
     * page that shows no Shammy never compiles the grain shader.
     */
    function program(name) {
        if (programs[name]) { return programs[name]; }
        var prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER,
            [PREAMBLE, UNIFORMS, "", body(WEAVES[name])].join("\n")));
        gl.bindAttribLocation(prog, 0, "aPos");
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prog));
        }
        var entry = { prog: prog, loc: {} };
        ["uBase", "uAxis", "uContrast", "uSeed"].forEach(function (u) {
            entry.loc[u] = gl.getUniformLocation(prog, u);
        });
        programs[name] = entry;
        return entry;
    }

    function supported() {
        if (!tried) { init(); }
        return ready;
    }

    /* ---- per-swatch inputs ------------------------------------------------- */

    function rgbOf(entry) {
        if (entry.rgb) { return entry.rgb; }
        var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(entry.hex || "");
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }

    /*
     * Whether this shader has what it needs to draw an entry: a colour, and the
     * `nap` block its three numbers come out of. The Light Jungle prints have
     * no nap block and keep their photograph.
     *
     * Named the same as the one in suede.js so a caller can hold either module
     * and ask the same question of it.
     */
    function has(entry) {
        return Boolean(entry && entry.nap) && rgbOf(entry) !== null;
    }

    /*
     * The seed only has to be stable and well spread — the same swatch draws the
     * same fabric on every visit, and no two swatches draw the same fabric.
     */
    function seed(key) {
        var h = 2166136261;
        for (var i = 0; i < key.length; i += 1) {
            h ^= key.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        return [(h & 0xffff) / 65536 * 64, ((h >>> 16) & 0xffff) / 65536 * 64];
    }

    /* ---- drawing ----------------------------------------------------------- */

    /*
     * Renders `entry` into `target`, a 2-D canvas, at `size` device pixels
     * square. Returns false if there is nothing to draw with, so the caller can
     * fall back to the photograph or the flat hex.
     *
     * `product` is what the entry does not know about itself: the weave its
     * cloth takes unless the entry asks for another, and how far its capture's
     * lighting is to be believed. Both are properties of the product rather
     * than of the colour, so both arrive from the same place.
     *
     * Every swatch is the same four uniforms and one triangle, so a page of
     * them costs one shader compile per weave in use.
     */
    function paint(target, entry, size, product) {
        var rgb = rgbOf(entry);
        if (!rgb || !entry.nap || !supported()) { return false; }

        product = product || {};
        var nap = entry.nap;
        var s = seed(entry.slug || entry.name || "");
        var name = weaveOf(entry, product.weave);
        var p;
        try {
            p = program(name);
        } catch (e) {
            return false;
        }

        gl.useProgram(p.prog);
        gl.uniform3f(p.loc.uBase, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        gl.uniform3f(p.loc.uAxis, nap.axis[0], nap.axis[1], nap.axis[2]);
        gl.uniform1f(p.loc.uContrast,
                     tame(flatten(closeup(nap.contrast, product.closeup),
                                  rgb, product.light), name) / 255);
        gl.uniform2f(p.loc.uSeed, s[0], s[1]);

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        target.width = size;
        target.height = size;
        var ctx = target.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(gl.canvas, 0, 0, RENDER_PX, RENDER_PX, 0, 0, size, size);
        return true;
    }

    /*
     * The same shader with this swatch's four inputs frozen into it, as text.
     *
     * The point of handing it over is that a swatch here is a number and a
     * recipe rather than a picture, and both halves should be takeable: the
     * constants below are the whole of what makes this colour this colour, so
     * the listing runs anywhere a fragment shader runs without lt.json or any
     * of this page. It needs no WebGL to produce — an entry with a nap block
     * has a shader to give whether or not this browser can draw it.
     *
     * `opts` is what the product knows and the entry does not: which weave to
     * draw it with, how far to believe its capture's lighting, and what to call
     * the product in the header.
     */
    function source(entry, opts) {
        var rgb = rgbOf(entry);
        if (!rgb || !entry.nap) { return null; }

        opts = opts || {};
        var nap = entry.nap;
        var s = seed(entry.slug || entry.name || "");
        var name = weaveOf(entry, opts.weave);
        var drawn = tame(flatten(closeup(nap.contrast, opts.closeup),
                                 rgb, opts.light), name);

        function vec(values, digits) {
            return "vec" + values.length + "(" + values.map(function (v) {
                return v.toFixed(digits);
            }).join(", ") + ")";
        }

        /*
         * A header, because this leaves the page and arrives somewhere with no
         * context at all — a scratch file, a shader editor, a paste into a
         * message. It should say what it draws, which of the shaders drew it,
         * and where the numbers came from.
         */
        var id = entry.sku || entry.code;
        var head = [
            "// " + (opts.product || "Ultrasuede LT") + " — " + entry.name +
                (id ? " (" + id + ")" : ""),
            "//",
            "// The " + name + " nap shader from the Footbag Fabric Library page,",
            "// with this swatch's numbers frozen in. Fragment shader;",
            "// vUv runs the unit square."
        ].join("\n");

        var consts = [
            "const vec3 uBase = " + vec([rgb[0] / 255, rgb[1] / 255,
                rgb[2] / 255], 6) + ";  // median colour, 0-1",
            "const vec3 uAxis = " + vec(nap.axis, 6) +
                ";  // luminance-normalised RGB direction",
            /*
             * The drawn figure, not the sampled one, because this listing has
             * to draw the swatch the reader is looking at rather than the one
             * the file describes. The sampled number is put beside it — it is
             * the measurement, and it is the thing worth having if this is
             * being read to find out what the cloth does.
             */
            "const float uContrast = " + (drawn / 255).toFixed(6) +
                ";  // standard deviation, 0-1" +
                (drawn === nap.contrast ? "" :
                    "\n                                   // (sampled " +
                    (nap.contrast / 255).toFixed(6) + ", on the library scale)"),
            "const vec2 uSeed = " + vec(s, 4) + ";"
        ].join("\n");

        return [head, "", PREAMBLE, "", consts, "", body(WEAVES[name]), ""]
            .join("\n");
    }

    return {
        paint: paint,
        source: source,
        supported: supported,
        has: has,
        weaves: WEAVES,
        weaveOf: weaveOf
    };
}());
