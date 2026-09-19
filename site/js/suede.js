/*
 * Synthetic Suede Fabric Library — the suede shader.
 *
 * The second shader, and a different job from the first. nap.js draws a swatch
 * the way the archive's camera saw it: its base colour, its measured spread,
 * and a raking-light ramp, all fitted per product to whoever photographed it.
 * That is a good likeness of a photograph and a bad model of a fabric. A
 * photograph of suede is the cloth times a studio — one light, off to one side,
 * at one distance — and every cloudy swatch on that page is the studio rather
 * than the cloth. The fabric itself is one colour all the way across.
 *
 * So this one is built the other way round: a material, not a picture. What
 * goes in is what the cloth is — its dye, and the geometry of its nap. What
 * comes out is that material under whatever light the caller asks for. A swatch
 * asks for flat, even, head-on light, because that is what a swatch is for: a
 * reader comparing two colours should be comparing two dyes, not two lighting
 * set-ups. A 3D model asks for its own scene's light, and gets the same
 * material answering it differently.
 *
 * TILEABLE
 *
 * Everything here is periodic on the unit square, and that is a constraint on
 * the method rather than a property to be checked afterwards. A material that
 * goes on a 3D model has to wrap, and two things the first shader does make
 * wrapping impossible: it rotates each noise layer by an arbitrary angle, which
 * carries the lattice off its own period, and it adds a linear ramp across the
 * frame for the studio's raking light, which cannot meet itself at the edge at
 * all. The ramp is gone on its own merits — it is the lighting this file exists
 * to remove. The rotations are replaced by co-prime frequencies, which buy the
 * same decorrelation without leaving the lattice. See `gnoise`.
 *
 * WHERE THIS IS
 *
 * Step one was the dye and nothing else. Step two was the fibre field: which
 * way the nap lies at each point. Step three was the light term, so the field
 * became visible through the cloth rather than only through the debug views.
 * Step four, which is this file today, gives the pile a body: a height, the
 * slope of it, the shadow it casts down into itself, and a lean that knows
 * where that height is. That is what makes
 * suede read as something with depth rather than as a pattern printed on a
 * plane, and it is the thing the first shader could never have had, since a
 * photograph of a flat swatch has the depth already baked into it.
 *
 * All of it is written in tangent space and takes its light and view directions
 * as uniforms, so a 3D model passes its own and the rest stands unchanged. The
 * `normal` view hands a pipeline the relief map to go with it.
 *
 * Nothing here is fitted to a photograph, and nothing here is per product. If
 * something has to differ between two cloths it should differ because they are
 * different cloth, with a number that says so.
 *
 * That is a narrower claim than it may look, and it got narrower once the pile
 * went in, so it is worth saying exactly. The archive's photographs are still
 * evidence about the cloth and they are read as such: they are what says the
 * nap keeps 87 per cent of its texture below 1.25mm, and what says its
 * brightness distribution is symmetric, and both of those settled a constant
 * below that had previously been settled by argument and settled wrongly. What
 * is refused is fitting a *picture* — taking one swatch's cloud, or one
 * swatch's contrast, and writing it into that swatch, which is what nap.js does
 * and what makes its output a likeness rather than a material. A measurement
 * taken across thirty photographs and spent on one number for the whole cloth
 * is the opposite of that. The test is whether the constant describes suede or
 * describes a photograph of one piece of it, and where a photograph can only
 * answer the second question — its contrast, most of all — it is used as a
 * bound and not as a target.
 */

var Suede = (function () {
    "use strict";

    /* ---- how much is drawn --------------------------------------------------
     *
     * Everything is drawn larger than it is shown and scaled down, so a tile and
     * the popover's large view are the same cloth at two magnifications rather
     * than two different cloths.
     *
     * That is not generosity, it is the thing that makes a fine grain possible
     * at all. Noise drawn at the size it is displayed aliases: a clump landing
     * between two pixels is a clump that flickers as the grid scrolls, and the
     * honest way out is to draw more samples than are kept and let the downscale
     * average them.
     *
     * The ceiling on that, and the size of the one offscreen canvas. Nothing
     * draws larger, so the popover's 512 is the biggest thing here and it gets
     * the whole canvas; a tile gets a quarter of it and the gauge a sixteenth.
     * The canvas is never resized to suit — reallocating a drawing buffer costs
     * more than every pixel it would save — so a draw sets a viewport and blits
     * back out of the corner it filled.
     */
    var MAX_PX = 2048;

    /*
     * How many samples a finished pixel is averaged from, per axis. Four, so a
     * 256px tile is drawn at 1024 and the popover's 512 at 2048 — the cap, and
     * what the whole library used to be drawn at.
     *
     * A tile was drawn at 2048 too, which is 64 samples a pixel where 16 do the
     * same job: measured against it on four swatches spanning the range, the
     * tile mean is unchanged to 0.00 of an 8-bit step, texture contrast moves
     * by at most 2%, and the per-pixel rms difference is 0.4 to 1.2 of 255 —
     * under the smallest difference the framebuffer can hold. What it costs is
     * a quarter of the fragments: 25.4ms of GPU per tile down to 8.3, and the
     * whole page's 297 tiles from about 7.5 seconds of GPU work to 2.5.
     *
     * Eight is where it stops paying and four is not the floor of what works —
     * two (a 512 tile) was tried and is visibly wrong: contrast comes out 9 to
     * 16% high, because at that rate the fine octave aliases rather than
     * averages and the cloth reads grainier than it is.
     *
     * The ladder does not move with this. See LADDER_PX.
     */
    var SAMPLES = 4;

    function renderPx(size) {
        return Math.min(size * SAMPLES, MAX_PX);
    }

    /*
     * The sampling rate the octave ladder is chosen against, which is fixed at
     * the cap rather than following whatever a given draw renders at.
     *
     * Render size and grain size are one decision — drop the render size and
     * the ladder below quietly loses its top octave, because MIN_PX stops
     * believing in it. That coupling is right when there is one render size.
     * With two it would mean a tile and the popover's large view were different
     * cloth, which is the one thing this file promises they are not: the tile
     * would be a two-octave nap and the detail a three-octave one, and
     * comparing them would compare the renderer.
     *
     * So the ladder is pinned here and the sample count moves under it. A tile
     * drawn at 1024 carries the 314-cycle octave at 3.3 pixels a cycle, under
     * MIN_PX and knowingly so: it is not resolved at that rate, it is averaged,
     * which is what the downscale to 256 was always going to do with it. The
     * measurement above is what says that is all right, and it is a measurement
     * of this exact arrangement.
     */
    var LADDER_PX = MAX_PX;

    /* ---- what a tile stands for --------------------------------------------
     *
     * A frequency in this file is cycles across the tile, and a tile is a piece
     * of cloth about 60mm square — roughly what the archive's swatch
     * photographs frame. That number does nothing in the shader; it is here so
     * the octaves below can be read as sizes of real thing rather than as
     * tuning, and so that putting this material on a 3D model is a matter of
     * saying how many millimetres a UV unit covers.
     */
    var TILE_MM = 60;

    /* ---- the fibre field ---------------------------------------------------
     *
     * The one thing about a piece of suede that genuinely varies across it.
     *
     * Synthetic suede is a non-woven mat of very fine fibre, raised and brushed
     * so the pile stands off its backing and leans. The fibres are far too fine
     * to see one — what is visible is how they clump, a lay direction that
     * holds over a millimetre or two and then turns. That is the whole of the
     * texture. It is not a colour variation, and drawing it as one is the
     * mistake the first shader inherited from the photographs.
     *
     * So the field is a direction, not a brightness: a 3D unit vector per point,
     * mostly upright and leaning by TILT. Nothing reads it yet except the debug
     * views — the light term is what turns a direction into something you can
     * see, and that is the next step. Keeping the two apart is the point of the
     * whole file: a direction field can be checked against how suede actually
     * lies, and a brightness field can only be checked against a photograph.
     *
     * How big a clump is, in millimetres, is the one number worth arguing
     * about, so it is the one number here. GRAIN_MM is the coarsest thing in
     * the field — the largest scale at which the lay is doing anything — and
     * everything else follows from it.
     *
     * The first band tried was 7.5mm, and it was far too big. Synthetic suede
     * is not a napped woollen; it is a mat of microfibre a few microns across,
     * and what the eye picks up is a very fine tooth, not a drift you could see
     * from across a room. A 60mm swatch showed eight clumps across it and read
     * as watercolour.
     *
     * It went finer twice more from there, to 0.35 and then to 0.2 — three
     * hundred clumps across a swatch, comfortably under one displayed pixel
     * each. That is where the texture stops being a pattern you look *at* and
     * becomes a surface quality you look *through*: what the eye gets is that
     * the cloth has a tooth, not what shape the tooth is, which is the correct
     * account of looking at real suede from arm's length.
     *
     * Fineness used to have to be paid for and now very nearly does not, which
     * is the clearest thing the pile changed about this end of the file.
     *
     * A tile is drawn into 256px and shown at 117 CSS px for a 60mm swatch, so
     * the downscale averages away exactly the detail a finer grain adds, and
     * with the lean carrying the whole texture the tooth simply faded as
     * GRAIN_MM came down — the cloth going back to flat dye by the least
     * interesting route. FILL was the lever that put it back, and it had to move
     * a long way: from 0.750 at 0.35mm to 0.475 at 0.15mm to hold the drawn
     * tooth level. Which meant the material was being made much louder so that
     * a thumbnail could look unchanged, and 0.2mm was as far as that seemed
     * worth taking.
     *
     * The same sweep now, with the pile in place and FILL re-solved at each step
     * against a fixed drawn tooth:
     *
     *   grain   cycles   FILL    tooth at 256   at 512
     *   0.35      171    0.750       1.16        1.57
     *   0.25      240    0.733       1.16        1.64
     *   0.20      300    0.722       1.16        1.67
     *   0.15      400    0.710       1.16        1.68
     *
     * FILL moves by 0.040 across the whole range where it used to move by 0.275,
     * and the price at magnification is about a seventh of what it was. The reason
     * is that most of the visible tooth is the pile's now and the pile does not
     * move when the lean does, so making the lean finer costs a much smaller
     * share of the picture. What the lean still sets is the character of the
     * fine grain rather than the amount of it, and 0.2mm stays where it is
     * because it is where the grain stops being a pattern with a shape and
     * becomes a surface quality, which is the whole of what it is for.
     *
     * There is a hard floor under all of this at LADDER_PX / MIN_PX cycles,
     * which is 0.147mm as things stand. Below it the ladder is measuring its own
     * sampling and no amount of FILL is a remedy.
     *
     * The octaves ladder up from there by RATIO and halve in weight, which is
     * the usual 1/f shape for a field with no scale of its own. RATIO is phi
     * squared, so consecutive frequencies land on or beside Fibonacci numbers
     * and stay co-prime: no two octaves' lattices come into register anywhere
     * on the tile. That is the job the first shader's per-layer rotations were
     * doing. Rotation is not available here — it takes a layer off its own
     * period and the tile stops wrapping — and co-primality buys the same thing
     * without leaving the lattice.
     *
     * The ladder stops when an octave gets finer than MIN_PX pixels a cycle,
     * because past that the render is not drawing the octave, it is drawing the
     * sampling of it. This is a real ceiling and not a safety margin: a field
     * cannot carry detail the thing it is drawn on cannot hold, and adding an
     * octave below it swaps structure for noise. So the fine end is set by the
     * render and the coarse end by the cloth, and GRAIN_MM decides how many
     * octaves fit between them — four at 3mm, three at 1.5mm, two at 0.5mm,
     * and at 0.35 one, where the field is a single scale and the ladder has
     * nothing further to say.
     *
     * At GRAIN_MM = 7.5 this reproduces the original 8 / 21 / 55 / 144 exactly,
     * which is the check that the reparameterisation changed the number and not
     * the model.
     */
    var GRAIN_MM = 0.2;
    var RATIO = 2.618;
    var MIN_PX = 5;

    /*
     * The ladder for a band whose coarsest scale is `mm`. Two bands come off
     * it — the lean's at GRAIN_MM and the pile height's at TUFT_MM — because
     * how a clump leans and how high it stands are not the same size of thing.
     * See the pile, below.
     */
    function octaves(mm) {
        var list = [];
        var f = Math.round(TILE_MM / mm);
        var w = 1;
        while (list.length === 0 || LADDER_PX / f >= MIN_PX) {
            list.push({ cycles: f, weight: w });
            f = Math.round(f * RATIO);
            w /= 2;
        }
        return list;
    }

    /*
     * Standard deviation of one octave of quintic-interpolated gradient noise,
     * and then of the weighted sum of all of them, so every field below comes
     * out at unit variance whatever band it is drawn on. That is what lets
     * SWIRL be in radians and DEPTH be in standard deviations of pile height:
     * both bands are on the same scale even though they are different sizes.
     */
    var NOISE_SD = 0.2100;

    function bandSd(mm) {
        var v = octaves(mm).reduce(function (sum, o) {
            return sum + o.weight * o.weight;
        }, 0);
        return NOISE_SD * Math.sqrt(v);
    }

    /*
     * How far the pile leans off vertical, in radians. 35 degrees: enough that
     * which way a clump faces is going to matter a great deal to the light term,
     * which is the behaviour this whole model exists to get, and not so far that
     * the pile reads as flattened.
     *
     * One number for the whole cloth for now. It is the obvious next thing to
     * let vary — a real nap is not equally raised everywhere — but it should
     * vary because something says it does, and at the moment nothing does.
     */
    var TILT = 35 * Math.PI / 180;

    /*
     * The brush, and how far the cloth argues with it.
     *
     * Napped cloth is combed in manufacture and keeps a lay: run a hand one way
     * and it is smooth, the other way and it lifts. That is why a suede panel
     * has a "with the nap" direction at all, and why two pieces cut from the
     * same bolt the wrong way round do not match. So the lay is the mean of the
     * field and the clumping is a deviation from it — not two vectors added and
     * normalised, which is how this was written first and which is wrong twice
     * over. It gives no control of the angle, since what an added vector does
     * to a direction depends on the length of what it is added to; and where the
     * sum comes out near zero the normalise runs away, so the field spins
     * through whole turns in places and the comb disappears into it.
     *
     * An angle about a mean has neither problem, and SWIRL says in radians
     * exactly what it does. At 0.8 the standard deviation of the lay is about
     * 46 degrees: the comb is plainly the mean of the field, and a clump can
     * still turn far enough off it to catch the light quite differently from its
     * neighbour, which is the thing about suede worth drawing.
     *
     * The mean direction is across the tile. The nap has an orientation with
     * respect to the selvedge — that is how a bolt is milled and how a swatch is
     * cut off it, so everything cut square to the roll inherits the same comb —
     * and the only question is which way it is turned in the frame.
     *
     * It sat 16 degrees off vertical for a while, on the theory that a comb
     * lying on an axis would read as an artefact of the square frame rather than
     * as a property of the cloth. Then it went to vertical, because that is how
     * the archive's own photographs are framed. It is horizontal now, a quarter
     * turn from there, by eye and on request: against a page of swatches in a
     * grid the vertical comb read as part of the layout rather than as part of
     * the cloth, and turning it across breaks that. Which way the roll actually
     * ran is not something the archive settles — every image in it was framed by
     * a photographer, and a frame is a decision about the picture, not a
     * measurement of the fabric.
     *
     * Nothing in the tiling cares: the field wraps by its period, not by its
     * orientation, and a quarter turn maps the lattice onto itself exactly.
     */
    var SWIRL = 0.8;
    var LAY = 0;

    /* ---- the pile ----------------------------------------------------------
     *
     * Up to here the cloth has been a plane. Every point had the same normal,
     * +z, and the eye sat square on it, so `dot(n, v)` was 1 everywhere and the
     * asperity term was identically zero — fifteen per cent of the weight doing
     * nothing at all. Worse, with n and v both constant the only quantity in the
     * whole of the shading that varied was `dot(fibre, light)`. The entire
     * picture was a function of one scalar.
     *
     * That is measurable and it was measured, and it is why a swatch had no
     * highlights. Skew of the drawn tile came out at -2.0: a tight bright body
     * with a long tail downward, which is to say dark specks cut out of flat
     * dye. The bright pixels were not highlights, they were the parts that had
     * not been darkened, sitting above the mean only because normalising pulls
     * the mean down into the dark tail. No term in the model made a bright
     * thing. One scalar cannot produce two populations.
     *
     * So the pile gets a body. `relief` is a second field on its own band,
     * because how high a clump stands is a fact about a wider patch of cloth
     * than which way one leans, and `pile` returns its slope and its height
     * together — the two things a depth buys, taken off one field in one place.
     * It is separately seeded but not independent of the lean: CLUMP, below,
     * turns the lean toward the high ground, which is what makes the two read as
     * one tuft instead of two textures.
     *
     * THE SLOPE — BUMP
     *
     * The gradient of the relief, as a shading normal. Two consequences, and the
     * second is the one worth having:
     *
     *   The asperity term comes alive, since dot(n, v) is no longer 1. On a flat
     *   swatch it stays small; on a model it is most of what separates suede
     *   from matte paint.
     *
     *   The fibre now grows out of the surface rather than out of the plane, so
     *   `dot(fibre, view)` varies too. Brightness is a function of the slope as
     *   well as of the lean, and those are independent at a point — the value of
     *   a Gaussian field and its gradient are uncorrelated — so there are two
     *   axes now instead of one, and a place can be bright for a reason that has
     *   nothing to do with why its neighbour is dark. That is what a highlight
     *   is.
     *
     * The slope is exact — `relief` carries its own derivatives out of
     * `gnoise_d` — but it is still read in cells of the finest octave of the
     * relief band rather than per unit UV, which is all the factor of 2 * EPS
     * in `pile` is. That keeps the reading scale-free: the gradient of a field
     * grows with its frequency and a cell of it shrinks with it, so BUMP keeps
     * meaning the same thing when the band moves, which it would not if the
     * slope were read per unit UV.
     *
     * It was a central difference over that same step until the cost of it was
     * counted: ten samples of the relief per fragment where two will do, and
     * the relief is most of what a tile spends. The exact slope is not quite
     * the same texture. Measured against the difference on four swatches
     * spanning the library it reads 1.7 to 2.6 percent lower in contrast, at
     * an unchanged mean once `gauge` re-solves the fill, and 0.4 to 1.6 of an
     * 8-bit step away pixel for pixel. Every swatch on the site was looked at
     * before the change, so that is a drift to know about rather than one that
     * has been corrected for.
     *
     * BUMP was picked by the measurement above rather than by eye: it is the
     * *smallest* relief that makes the brightness distribution symmetric, which
     * is to say the least surface that buys a highlight. Swept with the depth
     * switched off, so what is being read is the slope's own doing:
     *
     *   BUMP   tip rms   skew of the drawn tile
     *   0.30    14.4     -0.60
     *   0.45    20.5     -0.13   <- shipped
     *   0.80    31.9     +0.20
     *   1.20    40.9
     *
     * What that table establishes is a tip angle rather than a gain, and the
     * difference showed up the moment the band beneath it moved. Run on the
     * lean's band the knee sat at BUMP 0.30; run on a 1.2mm band the same gain
     * gave 8.3 degrees and the knee moved to 0.80; run on the 0.5mm band it
     * shipped with it is 0.45. The knee has never moved in degrees. The gradient
     * of a field scales with its frequency, so the gain that buys a given slope
     * moves with the band and the slope itself does not. About twenty degrees
     * rms is the finding; BUMP is only how it is spelled here. Move the band and
     * the gain has to be re-solved, which is why the bench prints the angle.
     *
     * The photographs agree with the criterion, which is worth more than the
     * criterion agreeing with itself. Skew of thirty of them, high-passed to
     * drop the studio, has a median of -0.12 and runs -0.27 to +0.26: the cloth
     * is symmetric, and a model that cannot produce a bright pixel is wrong
     * about it and not merely dull.
     *
     * Skew has to be read at render scale. At 256px the downscale is averaging
     * sixty-four samples into every pixel, and averaging pulls any distribution
     * towards a Gaussian, which makes a flat surface look far less broken than
     * it is. What is being asked about is the material, so it is measured where
     * the material is.
     *
     * HOW BIG A TUFT IS — TUFT_MM
     *
     * The height does not run on the lean's band, and it should not. Which way
     * one clump of fibre leans is close to independent of which way the next one
     * leans — that independence is exactly what makes the tooth fine, and it is
     * why GRAIN_MM is as small as it is. How high the pile stands is not like
     * that at all. Fibres lean on their neighbours, the backing under them is
     * not flat, and the brush leaves tracks, so height stays correlated over
     * something nearer a millimetre.
     *
     * Drawn on the lean's band it could not be: at GRAIN_MM = 0.2 the ladder has
     * one rung, so the relief was a single scale, every tuft the same size as
     * every other and none of them gathered into anything.
     *
     * HOW BIG, THEN. The first answer was 1.2mm, on the reasoning above and
     * nothing else, and it was badly wrong — the swatch came out mottled with
     * clumps you could count, which is not what suede looks like from any
     * distance. The reasoning was not wrong so much as unquantified: height does
     * stay correlated further than lean, and the question was how much further,
     * and that is answerable rather than arguable.
     *
     * So it was answered. The archive's large swatch photographs are 418 pixels
     * across a 60mm swatch, about 7 a millimetre, and a radially averaged power
     * spectrum of thirty of them says where the cloth keeps its texture. Share
     * of the total energy, by octave band:
     *
     *   40mm   20    10     5    2.5   1.25   0.62   0.36
     *   1.2%  0.6%  0.8%  1.1%  1.9%   7.8%  34.6%  52.0%
     *
     * Eighty-seven per cent of it is finer than 1.25mm and half of it is at the
     * camera's resolution limit, which is to say finer than the camera can see.
     * Above 2.5mm there is essentially nothing — and what little there is, is
     * the studio, not the cloth. A 1.2mm band put the relief's whole weight into
     * a bin the cloth spends eight per cent of its energy on. Hence the clumps.
     *
     * TUFT_MM is 0.5 now, which lays the band on 120 / 314 cycles — 0.5mm and
     * 0.19mm — with both rungs inside the region where the cloth actually keeps
     * its texture, and the coarse rung only two and a half times the lean's.
     * Height is correlated further than lean, then, but by a factor of two or
     * three rather than of six.
     *
     * It is worth being clear about what this is not. It is not the cloudy
     * colour variation the photographs show and this file exists to remove —
     * that was a light brighter on one side of the cloth, it cannot tile, and it
     * does not survive a change of lighting. This is geometry. Turn the light to
     * flat and it goes away, exactly as a real surface does.
     *
     * HOW FAR DOWN THE LIGHT GETS — DEPTH
     *
     * A height field on its own is an emboss, not a pile. What makes plush look
     * plush is that it is deep and the light does not reach the bottom of it:
     * the fibre standing above a point shades it, so the gap between two tufts
     * is dark for a reason having nothing to do with which way anything points.
     * That is Beer-Lambert, and what it wants is the amount of fibre standing
     * above the point — which is a thing this file already knows, because the
     * height field's own distribution is the pile's density profile. The
     * fraction of the pile above height h is the Gaussian tail Q(h), so
     *
     *     reach(h) = exp(-DEPTH * Q(h))
     *
     * and DEPTH is the optical depth of the whole pile, top to bottom. The
     * logistic is the usual cheap stand-in for the tail, good to about half a
     * per cent and considerably cheaper than an erf.
     *
     * The first form tried was exp(-DEPTH * max(-h, 0)) — shade everything below
     * the mean height, in proportion to how far below. It is the obvious thing
     * and it draws badly, which is worth recording because the reason is not
     * obvious. `max` puts a kink in the derivative at exactly h = 0, and h = 0 is
     * where a Gaussian field spends most of its time, so the kink traces out the
     * field's median contour and draws it. The tile came out vermiculated —
     * dark worms with hard edges, cork rather than cloth. Nothing about that is
     * physical; it is the corner in the function, made visible.
     *
     * The tail form has no corner anywhere, and it also bounds itself, which the
     * first form did not: reach runs from exp(-DEPTH) at the bottom of the pile
     * to 1 at the top and no further, because once a point is under all of the
     * fibre there is no more fibre to get under. Below the pile everything is
     * equally dark, which is true and which the unbounded version got wrong.
     *
     * It is still one-sided in the sense that matters. The top of the pile is in
     * the open with nothing above it to shade it, and the darkening is entirely
     * a story about being buried. A symmetric light-and-dark is an emboss
     * whichever way it is lit; a one-sided one is depth.
     *
     * DEPTH is 0.20, and the photographs set it. Depth is the one term here that
     * moves the skew on its own — it only ever darkens — so it is the term the
     * cloth's own symmetry can be read against. Swept, with FILL re-solved at
     * each step to hold the drawn tooth fixed, so what changes is the shape of
     * the distribution and not its width:
     *
     *   DEPTH   fill    skew of the drawn tile
     *   0.00    0.342   -0.13
     *   0.15    0.337   -0.08
     *   0.20            -0.04   <- shipped
     *   0.30    0.350   +0.05
     *   0.55    0.392   +0.26
     *   0.90    0.449   +0.44
     *
     * against a photographed median of -0.12 over a range of -0.27 to +0.26. So
     * the cloth will carry a little depth and not much: past about 0.3 the tile
     * is measurably less like the photographs than a flat one would be, which is
     * a clear enough place to stop. It is a real term and a quiet one, which is
     * roughly what a two-millimetre pile ought to be.
     *
     * What it shades is the lamp and not the sky, which is a decision and was
     * not the first one tried. Occluding everything is what an ambient occlusion
     * map does, and it looked right until it was measured: it gives the material
     * a peak-to-mean ratio of about 1.16 that no amount of fill can remove, since
     * the tuft tops are at one however the cloth is lit. Country Cream is 249,
     * which is 2.4 per cent of headroom, so the guard below had nothing left to
     * give and seven per cent of the library clipped.
     *
     * The physics says the same thing the arithmetic does, which is the reason
     * to take it rather than work around it. Suede is not opaque. It is a mat of
     * pale translucent fibre, and light that has bounced about inside it arrives
     * at a buried point from below and from the side rather than down through the
     * canopy — so the diffuse component is very nearly not occluded at all. That
     * is also why pale suede looks shallower than dark suede in the first place:
     * a white pile scatters light into its own shadows and a black one absorbs
     * it. So the per-colour fill in `fillFor` stops being purely a guard and
     * starts describing something true — light cloth really does have less depth
     * in it, for this reason.
     *
     * And it restores the exact affine argument the gauge rests on: with the
     * occlusion inside the directional term, `uFill + (1 - uFill) * reach * brdf`
     * is still a straight line in fill at every pixel, so one measurement at
     * fill 0 fixes both the mean and the peak at every other fill exactly.
     */
    var BUMP = 0.45;
    var TUFT_MM = 0.5;
    var DEPTH = 0.20;

    /*
     * WHICH WAY A TUFT LEANS - CLUMP
     *
     * The two fields above are drawn independently: how high the pile stands at
     * a point and which way it leans there have, so far, had nothing to do with
     * one another. That is wrong about the cloth, and it is wrong in a way that
     * costs the picture rather than only the story.
     *
     * The cloth first. A pile is a transported material - it is brushed, and
     * brushing moves fibre about. Fibre heaps up where the brushing converges
     * and thins where it spreads, so a crest in the height is, by construction,
     * a place the surrounding fibre leans into. Height is the divergence of the
     * lean, near enough; the two fields are one field seen twice.
     *
     * The picture second, which is the reason to bother. With the fields
     * independent, a lit streak from the lean lands wherever it likes with
     * respect to a crest in the height, and about half the time it lands in a
     * hollow and is cancelled by the occlusion there. Two textures at the same
     * scale, uncorrelated, average toward mush - which is the thing that is
     * hardest to get rid of by turning any single knob up, because turning
     * either one up adds as much cancellation as signal. Correlated, a tuft is
     * lit on the side the light is on and shaded on the other, and it reads as
     * one object with a shape rather than two coincident patterns.
     *
     * So the lean turns toward the uphill direction of the relief, by CLUMP
     * times the local slope:
     *
     *     d = (cos a, sin a) - CLUMP * n.xy
     *
     * n.xy is the tangent-space normal's horizontal part, which points downhill
     * with a magnitude that is the sine of the tip angle, so subtracting it
     * turns the lean uphill in proportion to how steep the flank is. Flat ground
     * keeps the lean it had; a steep flank swings it at the crest above it. That
     * is the right dependence and not merely a convenient one: a tuft is the
     * convergence, so the flanks are exactly where fibre is leaning in and the
     * tops and hollows are where it is not.
     *
     * It costs nothing. There is no second field and no extra noise tap - the
     * gradient is already computed for the shading normal and is being thrown
     * away after. CLUMP = 0 is the uncorrelated shader exactly, term for term.
     *
     * The sign is a real choice and the other one is arguable: fibre that has
     * fallen over leans downhill, away from the heap it came off. Both were
     * drawn. Uphill gives a tuft a lit flank and a shaded flank on opposite
     * sides, which is what a plush pile does; downhill lights the two flanks the
     * same way and reads as an emboss, a bumpy surface rather than a fibrous
     * one. Uphill is also the one with the transport argument behind it.
     *
     * CLUMP is 0.35, and it is small on purpose. The relief's normal has a
     * horizontal part of 0.388 rms, which is a tip of 22.8 degrees, so at 0.35
     * the coupling turns the lean by 5.5 degrees rms against the 45.8 degrees
     * SWIRL already gives it. An eighth. It is a bias on the wander and not a
     * replacement for it, and tufts that want to be found rather than counted
     * are the whole of the brief.
     *
     *   CLUMP   tooth   skew    what it draws
     *   ------  ------  ------  ----------------------------------------------
     *   -0.70   6.98%   -0.03   downhill: bumps, lit the same on both flanks
     *   -0.35   7.07%   -0.05   downhill, faint
     *    0.00   7.12%   -0.07   uncorrelated - even, but no structure in it
     *    0.35   7.15%   -0.09   the grain gathers into strokes
     *    0.70   7.15%   -0.11   strokes read as separate clumps
     *    1.20   7.11%   -0.14   combed; the construction is showing
     *
     * Read on a 512px tile, high-passed at 2.5mm, so the tooth is not the
     * number the `versus` section prints at 418.
     *
     * The tooth is flat across the whole of that - 6.98 to 7.15 per cent, less
     * than the spread between two swatches - and that is the point rather than
     * an aside. This is not another way of spending contrast. All of it was
     * already in the tile; the knob only decides whether it lands in a shape.
     * A knob that moved the tooth would be duplicating FILL, and the reason to
     * trust this one is precisely that it does not.
     *
     * What does move is the skew, monotonically, from -0.03 at the downhill end
     * to -0.14 at the far uphill end. That is the tuft acquiring a shaded side:
     * turning the lean into the crest darkens the far flank faster than it
     * brightens the near one. The photographs' skew runs -0.27 to +0.26 with a
     * median of -0.12, so the whole of this sweep sits inside the cloth and no
     * part of it is excluded - which is the honest statement. Correlation at
     * half a millimetre is below what a 7 px/mm photograph resolves, and no
     * measurement here settles the value. It is argued from the cloth and set
     * where the argument still holds and the drawing has not begun to show its
     * own construction.
     */
    var CLUMP = 0.35;

    /*
     * WHERE THE LEAN IS SAMPLED - SCATTER
     *
     * This one is not about cloth. It is here to remove a drawing artefact, and
     * saying so plainly is better than dressing it up, because the physical
     * reading below is true but it is not the reason.
     *
     * THE FAULT
     *
     * Gradient noise is not broadband. It is built on a square lattice and it is
     * exactly zero at every lattice point, so a single octave of it carries a
     * deterministic periodic component at its own lattice frequency, aligned to
     * the axes. On a fabric that reads as a crosshatch - a fine regular quilting
     * over the whole swatch, which is the one thing suede certainly is not.
     *
     * The quintic interpolant, above, fixes a different lattice: the kink
     * smoothstep leaves in the first derivative at a cell boundary. It does
     * nothing about this one, which is in the noise and not the interpolation.
     *
     * It measures enormous. A 2-D power spectrum of the render puts spikes at
     * exactly (300, 0) and (0, 300) cycles - the lean band's frequency, on both
     * axes - standing 4349 and 4158 times the median power of their own radial
     * ring. Broadband noise scores 1. Delivered to a 512px tile the spike folds
     * to bin 212 and to bin 44 at 256px, which is a 1.4mm grid: coarse, regular
     * and impossible to miss once seen.
     *
     * The lean band is the one that shows it because it is the only band with a
     * single rung. GRAIN_MM = 0.2 puts it at 300 cycles and the next rung up the
     * ladder would be 785, which fails the MIN_PX floor, so the ladder stops at
     * one. The pile's band has two rungs at 120 and 314 and measures 46 - the
     * file's co-primality argument, that near-Fibonacci frequencies stand in for
     * the per-layer rotation periodicity will not allow, works. It just needs
     * two layers to work with, and with one layer there is nothing to decorrelate
     * against and the lattice comes through undisguised.
     *
     * WHAT DOES NOT FIX IT
     *
     * Three things were tried first, and all three are worth recording because
     * each is the obvious move and each is wrong.
     *
     *   A better reduction. The tile is rendered at 2048 and reduced, so the
     *   suspicion is the reduction. An exact box average from 2048 measures
     *   798.9 against drawImage's 806.4. The tone is in the render.
     *
     *   More render. At a 4096 render the band gets 13.7 pixels a cell instead
     *   of 6.8 and the tone measures 478.8. Halved, not removed, and the cost is
     *   four times the pixels. It is not an under-sampling artefact.
     *
     *   A coarser grain. Moving GRAIN_MM does not remove the grid, it moves it:
     *   at 0.5mm the tone is 639.8 at bin 120 - no longer folded, just drawn
     *   directly, and coarser, which is worse.
     *
     * WHAT DOES
     *
     * Jitter the lattice. The lean is read at
     *
     *     wander(uv + SCATTER * n.xy)
     *
     * so where the lean is sampled is displaced by the pile's own slope. n.xy
     * is periodic and wander is periodic, so the composition is periodic and the
     * tile still wraps - which a rotation, the usual fix for this, would not.
     * There is no new field and no new noise tap; the slope is already in hand.
     *
     * The quantity that matters is the displacement in lattice cells. n.xy has
     * an rms of 0.388, and at 300 cycles across the tile
     *
     *     0.004 * 0.388 * 300 = 0.47 cells
     *
     * which is the number to remember: about half a cell of jitter is what it
     * takes to destroy the phase coherence the spike is made of. The sweep says
     * the same thing - nothing happens until the displacement approaches half a
     * cell, and nothing further happens after.
     *
     *   SCATTER   cells   tone   axis share     sd 512      sd 256
     *   -------  ------  -----  -----------  ----------  ----------
     *     0.000    0.00  806.4        1.03%        7.34        4.93
     *     0.001    0.12  672.4        0.98%        7.33        4.94
     *     0.002    0.23  450.9        0.86%        7.29        4.97
     *     0.004    0.47   33.2        0.68%        7.11        4.95
     *     0.008    0.93   31.7        0.66%        6.68        4.68
     *     0.016    1.86   30.0        0.63%        6.34        4.44
     *     0.030    3.49   38.8        0.61%        6.24        4.39
     *
     * `axis share` is the fraction of the tile's variance lying on the two axes
     * of its spectrum, which is where a square lattice puts itself. A field with
     * no lattice in it would put 2/N there by chance, which at N = 512 is 0.39
     * per cent. The fault was nearly three times that; at 0.004 it is under
     * twice, and the rest of the way down is the pile's band, not the lean's.
     *
     * The last two columns are the tile's plain sd over its mean, not the 2.5mm
     * high-pass the `versus` section prints, so they are not comparable with the
     * figures there; they are here only to say what the jitter costs.
     *
     * 0.004 is the knee and the cost of it is 3 per cent of that at 512 and none
     * at all at 256. Past the knee it falls without the tone falling any
     * further, which is the signature of jitter that has stopped breaking up the
     * lattice and started blurring the field. On the bench's own measure the
     * same step reads 7.38 to 7.15 per cent with the skew steady at -0.11,
     * against the photographs' median of -0.12.
     *
     * What is left at 33 is the relief band's fine rung at 314 cycles, folded to
     * bin 198. It sits an order of magnitude below what the lean's was and it is
     * diluted by that band's second rung, so it is left alone. If it ever needs
     * the same treatment the same warp will do it, driven by the lean instead.
     *
     * THE PHYSICAL READING
     *
     * It happens to be true, which is why this warp was chosen over an arbitrary
     * one: a fibre does not sit on the plane, it sits on a pile that slopes, so
     * the point of the backing its root is anchored at is displaced from the
     * point of the surface its tip shows at, by an amount that goes with the
     * slope. That is what the expression says. But the artefact is the reason it
     * is here, and 0.004 was set by the spike and not by the cloth.
     */
    var SCATTER = 0.004;

    function eps() {
        var band = octaves(TUFT_MM);
        return 0.25 / band[band.length - 1].cycles;
    }

    /* ---- the views ---------------------------------------------------------
     *
     * Which of three things a tile draws. One program each, compiled on demand,
     * and `source` hands over whichever one is on — the code a reader copies is
     * the code that drew the swatch they were looking at, not a paraphrase.
     *
     *   cloth   the material under the swatch rig, which is what this ships as
     *   fibre   the fibre vector as a normal map: red and green are how the
     *           pile leans, blue is how upright it stands. The standard
     *           encoding, and the one that shows tilt and direction at once
     *   lay     the lean direction alone, as a hue wheel. Throws away tilt and
     *           in exchange makes the clumping and the comb legible at a glance
     *
     * Scaffolding, both of the last two, now that the light term has landed and
     * the field can be seen through the cloth. They are kept because a direction
     * is still easier to judge as a direction than as a shade of red, and the
     * bench draws all three side by side.
     */
    var VIEW = "cloth";

    /* ---- the shader --------------------------------------------------------
     *
     * Assembled from pieces rather than written out whole, so that the octave
     * table above is the only place the frequencies live, and so that what is
     * emitted carries no commentary. A copied shader should be the thing that
     * runs and nothing else — the explanation is this file, and it does not
     * travel with the code. Every note about the GLSL below is therefore a JS
     * comment sitting beside the string rather than a `//` inside it.
     */

    var VERT = [
        "attribute vec2 aPos;",
        "varying vec2 vUv;",
        "void main() {",
        "    vUv = aPos * 0.5 + 0.5;",
        "    gl_Position = vec4(aPos, 0.0, 1.0);",
        "}"
    ].join("\n");

    var PREAMBLE = [
        "precision highp float;",
        "",
        "varying vec2 vUv;"
    ].join("\n");

    var UNIFORMS = [
        "uniform vec3 uBase;",
        "uniform vec2 uSeed;",
        "uniform vec3 uLight;",
        "uniform vec3 uView;",
        "uniform float uFill;",
        "uniform float uNorm;"
    ].join("\n");

    /*
     * Periodic gradient noise, and the two choices in it that the tiling
     * depends on.
     *
     * Gradient rather than value noise, which is what the first shader used.
     * Value noise carries the lattice's own axes in it, and that shows as a
     * faint square weave — tolerable there because every layer was turned to a
     * different angle and the axes never agreed. Nothing can be turned here, so
     * the noise itself has to be the isotropic kind.
     *
     * `mod(i, period)` is the whole of the tiling. The lattice cell a point
     * falls in is wrapped by the octave's frequency before it is hashed, so the
     * cell at the right edge of the tile is the same cell as the one at the left
     * and the field meets itself exactly. It costs the frequencies having to be
     * whole numbers, which they are.
     *
     * A constant offset — uSeed — survives that untouched: shifting by a whole
     * period's worth of cells returns the same values, whatever the shift, so
     * every swatch is a different piece of the same cloth and every one of them
     * still wraps.
     *
     * The interpolant is quintic rather than smoothstep. Smoothstep leaves a
     * kink in the first derivative at every cell boundary, and a field of those
     * kinks lines up into a visible square lattice — which on a fabric reads
     * unmistakably as a woven crosshatch. Suede is not woven. The quintic is
     * flat to the second derivative at the boundary and it goes away.
     *
     * The interpolant being a polynomial buys the derivative almost free, which
     * is what `gnoise_d` returns alongside the value. The four corner gradients
     * are the whole cost of a sample — two hashes, a sine and a cosine each —
     * and the slope of the interpolation is another polynomial in those same
     * four. So a field's gradient costs a handful of multiplies rather than
     * four more samples of the field, which is what `pile` below used to pay:
     * a fragment reads three noise samples now where it read eleven.
     *
     * `gnoise` is the value on its own, written through `gnoise_d` so that one
     * interpolant serves both rather than two that have to be kept in step.
     * The derivative nothing asked for folds away when it is inlined.
     */
    var NOISE = [
        "float hash1(vec2 i, float salt) {",
        "    vec3 p = fract(vec3(i, salt) * 0.1031);",
        "    p += dot(p, p.yzx + 33.33);",
        "    return fract((p.x + p.y) * p.z);",
        "}",
        "",
        "vec2 grad(vec2 i, float period, float salt) {",
        "    float a = hash1(mod(i, vec2(period)), salt) * 6.2831853;",
        "    return vec2(cos(a), sin(a));",
        "}",
        "",
        "vec3 gnoise_d(vec2 p, float period, float salt) {",
        "    vec2 i = floor(p);",
        "    vec2 f = p - i;",
        "    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);",
        "    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);",
        "    vec2 ga = grad(i, period, salt);",
        "    vec2 gb = grad(i + vec2(1.0, 0.0), period, salt);",
        "    vec2 gc = grad(i + vec2(0.0, 1.0), period, salt);",
        "    vec2 gd = grad(i + vec2(1.0, 1.0), period, salt);",
        "    float a = dot(ga, f);",
        "    float b = dot(gb, f - vec2(1.0, 0.0));",
        "    float c = dot(gc, f - vec2(0.0, 1.0));",
        "    float d = dot(gd, f - vec2(1.0, 1.0));",
        "    float k = a - b - c + d;",
        "    float v = mix(mix(a, b, u.x), mix(c, d, u.x), u.y);",
        "    vec2 dv = ga + u.x * (gb - ga) + u.y * (gc - ga)",
        "            + u.x * u.y * (ga - gb - gc + gd)",
        "            + du * vec2(b - a + u.y * k, c - a + u.x * k);",
        "    return vec3(v, dv);",
        "}",
        "",
        "float gnoise(vec2 p, float period, float salt) {",
        "    return gnoise_d(p, period, salt).x;",
        "}"
    ].join("\n");

    /*
     * The octave sum, written out from the ladder, at unit standard deviation
     * so that SWIRL below is in radians and means it.
     *
     * Each octave takes its own multiple of the seed, so no two of them shift
     * together between one swatch and the next.
     *
     * `slope` writes the vec3 form instead: the value and its two derivatives,
     * summed the same way, since a sum's derivative is the sum of them. Each
     * octave's gradient carries its own frequency because the octave samples
     * the noise at uv * f, and the chain rule has to come back out to uv.
     */
    function fieldBody(mm, salt, seed, slope) {
        var lines = octaves(mm).map(function (o, i) {
            var f = o.cycles.toFixed(1);
            return "        " + (i ? "+ " : "  ") + o.weight.toFixed(4) +
                " * " + (slope ? "gnoise_d" : "gnoise") + "(uv * " + f +
                " + uSeed * " + (seed + i * 1.7).toFixed(1) + ", " + f + ", " +
                (salt + i).toFixed(1) + ")" +
                (slope ? " * vec3(1.0, " + f + ", " + f + ")" : "");
        });
        return "    return (\n" + lines.join("\n") + "\n    ) / " +
            bandSd(mm).toFixed(4) + ";";
    }

    /*
     * The material at a point: what the cloth is there, before any light has
     * touched it.
     *
     * Two things, kept apart. The colour is one number for the whole swatch,
     * because that is what a bolt of piece-dyed suede is — the variation a
     * photograph shows is the studio, and the measured `contrast` in the product
     * files is a measurement of that studio, so it is not read here. The fibre
     * is where all the variation lives.
     *
     * Colour and geometry never mix, all the way down, so that changing the
     * light can never change the dye.
     */
    function materialBody() {
        return [
            "float wander(vec2 uv) {",
            fieldBody(GRAIN_MM, 1.0, 1.0),
            "}",
            "",
            "vec3 relief(vec2 uv) {",
            fieldBody(TUFT_MM, 11.0, 2.3, true),
            "}",
            "",
            "vec4 pile(vec2 uv) {",
            "    vec3 r = relief(uv);",
            "    vec2 slope = r.yz * " + (2 * eps()).toFixed(8) + ";",
            "    return vec4(normalize(vec3(-slope * " + BUMP.toFixed(4) +
                ", 1.0)), r.x);",
            "}",
            "",
            "float reach(float h) {",
            "    return exp(-" + DEPTH.toFixed(4) +
                " / (1.0 + exp(1.702 * h)));",
            "}",
            "",
            "vec3 fibre(vec2 uv, vec3 n) {",
            "    float a = " + LAY.toFixed(6) + " + " + SWIRL.toFixed(4) +
                " * wander(uv + " + SCATTER.toFixed(8) + " * n.xy);",
            "    vec2 d = vec2(cos(a), sin(a)) - " + CLUMP.toFixed(4) +
                " * n.xy;",
            "    d /= max(length(d), 0.001);",
            "    vec3 f = vec3(d * " + Math.sin(TILT).toFixed(6) + ", " +
                Math.cos(TILT).toFixed(6) + ");",
            "    vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), n));",
            "    vec3 b = cross(n, t);",
            "    return f.x * t + f.y * b + f.z * n;",
            "}",
            "",
            "vec3 dye(vec2 uv) {",
            "    return uBase;",
            "}"
        ].join("\n");
    }

    /* ---- the light ---------------------------------------------------------
     *
     * What the material looks like from here: a scalar on the albedo, never a
     * shift of it. Suede's fibres are dyed through and light bounces between
     * them several times before it leaves, so turning a piece of it in the hand
     * changes the brightness enormously and the hue almost not at all. That is
     * the single most characteristic thing about the cloth, and writing the
     * light term as a multiplier is what guarantees it: there is no path here by
     * which a light can change a colour.
     *
     * Everything is in tangent space — the cloth's macro surface is the z = 0
     * plane and its normal is +z. A swatch passes the rig below; a 3D model
     * passes its own light and view vectors transformed into the same frame, and
     * nothing else has to change. That is why these are uniforms rather than
     * constants.
     *
     * THE MODEL
     *
     * Kajiya-Kay (1989), which is the standard shading model for a surface made
     * of fibres — hair, fur, brushed metal, pile fabric. A fibre is a cylinder,
     * so it has an axis rather than a normal, and both terms are written in the
     * angles that the light and the eye make with that axis:
     *
     *   SIDE   the diffuse term, sin of the angle between fibre and light. A
     *          cylinder catches most light across its axis and none along it, so
     *          a clump lying across the light is bright and one pointing at it is
     *          dark. This is most of why a brushed panel shows its brush marks.
     *
     *   TIP    the specular term, cos of the difference between the two angles.
     *          It peaks along the whole cone of directions that make the same
     *          angle with the fibre as the light does, which is what gives pile
     *          fabric its broad directional sheen rather than a point highlight.
     *          SHEEN is low because suede is matte: a high exponent would make it
     *          satin.
     *
     * Then a third term that is not Kajiya-Kay and matters for the 3D case:
     *
     *   RIM    asperity scattering (Koenderink & Pont, 2003), the reason velvet
     *          and suede light up at their silhouette. Light entering the pile at
     *          a grazing angle scatters among the fibres and comes back out, so
     *          the edge of a curved piece is brighter than the face of it. It is
     *          keyed to the macro normal against the view, so on a flat swatch
     *          seen square on it is exactly zero and costs nothing. It is here
     *          for the model, where it is most of what distinguishes suede from
     *          matte paint.
     *
     * A fourth thing is not in this list and deliberately not in the material at
     * all: the ambient fill. No cloth is ever lit by one lamp alone, and without
     * some the dark side of a model goes to black, which suede conspicuously does
     * not do. But how much of the light in a room arrives from no particular
     * direction is a fact about the room, so it lives in the rig below as FILL
     * rather than here among the weights.
     *
     * The three weights sum to one, so `brdf` runs about zero to one and FILL
     * mixes against it on an honest scale.
     *
     * The weights are a starting set, not measurements — there is nothing in the
     * archive to fit them against, and fitting them to a photograph is what the
     * first shader does and what this one exists not to do. They are chosen so
     * that the cloth is matte, the nap is the dominant structure, and nothing
     * clips at either end.
     */
    var SIDE = 0.55;
    var TIP = 0.30;
    var SHEEN = 6.0;
    var RIM = 0.15;
    var RIM_SHARP = 3.0;

    function shadeBody() {
        return [
            "float brdf(vec3 f, vec3 l, vec3 v, vec3 n) {",
            "    float tl = dot(f, l);",
            "    float tv = dot(f, v);",
            "    float sl = sqrt(max(1.0 - tl * tl, 0.0));",
            "    float sv = sqrt(max(1.0 - tv * tv, 0.0));",
            "    float nl = max(dot(n, l), 0.0);",
            "    float nv = max(dot(n, v), 0.0);",
            "    return " + SIDE.toFixed(4) + " * sl * nl",
            "        + " + TIP.toFixed(4) + " * pow(max(tl * tv + sl * sv, 0.0), " +
                SHEEN.toFixed(1) + ") * nl",
            "        + " + RIM.toFixed(4) + " * pow(max(1.0 - nv, 0.0), " +
                RIM_SHARP.toFixed(1) + ");",
            "}",
            "",
            "float response(vec3 f, vec3 l, vec3 v, vec4 p) {",
            "    return uFill + (1.0 - uFill) * reach(p.w)",
            "        * brdf(f, l, v, p.xyz);",
            "}",
            "",
            "vec3 shade(vec3 albedo, vec3 f, vec4 p) {",
            "    return albedo * response(f, uLight, uView, p) * uNorm;",
            "}"
        ].join("\n");
    }

    /* ---- the swatch rig ----------------------------------------------------
     *
     * The light a swatch is shown under, and the one place this file has to
     * answer the question it was started over: a swatch should not look lit, and
     * a shading model needs a light.
     *
     * Two properties settle it, and between them a lit swatch can still be an
     * honest colour reference.
     *
     * It is a single distant source, so there is no gradient across the frame at
     * all. Every point on the tile gets exactly the same light from exactly the
     * same direction, and the only reason two points differ is that the nap lies
     * differently at them. That is the cloud in the photographs gone: what is
     * left varies because the fabric varies, which is the thing worth drawing.
     * It is also the only kind of light that can tile, which is not a
     * coincidence — a gradient cannot meet its own edge.
     *
     * And the rig is normalised so the mean of the tile is exactly the sampled
     * colour. See `norm`. A reader comparing two swatches is comparing two dyes,
     * and the nap is a texture about that colour rather than a departure from it.
     *
     * Two dials, and they are not the same dial, which is why ELEVATION alone was
     * not enough. ELEVATION decides what shape the nap takes — which clumps go
     * dark and which go bright. FILL decides how loud it is. Turning the first to
     * quieten the cloth also changes what the cloth looks like, which is the
     * wrong handle to reach for.
     *
     * ELEVATION is therefore set where the nap reads most clearly rather than
     * where it is quietest. Measured over the whole dial in 5 degree steps, the
     * spread of a drawn tile peaks at 55 to 60 degrees and falls away on both
     * sides, to exactly zero at 90. Both ends have a plain meaning. At 90 the
     * light runs straight down the line of sight, every fibre makes the same
     * angle with it whichever way it lies, and the tile is exactly flat dye —
     * which is where this file started, and it is worth something that the
     * earlier version turns out to be a special case of this one rather than a
     * different mode. The peak near 55 is the specular cone: the pile stands 35
     * degrees off vertical, so a square-on eye sits 35 degrees off the fibre, and
     * the response swings hardest as the light sweeps across the matching cone.
     *
     * The azimuth is across the comb rather than along it, which is where the
     * response varies fastest with the fibre angle — a lay distribution centred
     * on the steepest part of the curve rather than on a turning point of it. It
     * is also what a person does with a piece of suede to see the nap.
     *
     * FILL is the share of the light that arrives from no particular direction.
     * It is a real thing about a real room rather than a fudge: a swatch
     * photographed for colour is shot in a light tent or under a broad soft
     * source, which is mostly fill, and only the part of the light that has a
     * direction can tell one fibre from another. At 1 the swatch is flat dye
     * again, by the other route.
     *
     * 0.44 is where it sits, and the photographs put it there too, though with
     * less authority than they had over the shape of the nap.
     *
     * The measurement is the tooth: the standard deviation of a swatch after
     * everything coarser than 2.5mm is filtered out of it — that being the
     * studio — as a percentage of its mean. Over thirty of the archive's large
     * photographs the median is 7.74%. Drawing the same tile at the same 418px
     * and measuring it the same way, fill and tooth trade like this:
     *
     *   fill   0.521   0.440   0.409   0.340
     *   tooth   4.8%    6.0%    6.5%    7.74%
     *
     * The reason not to simply take 7.74 is that the number is an upper bound
     * rather than a target. Resample those photographs and the tooth falls 7.74%
     * at 418px to 5.02% at 256 to 2.35% at 128 — almost exactly as one over the
     * pixel count, which is how unresolved detail behaves and how sensor noise
     * behaves, and the camera cannot tell them apart. Some of that 7.74% is
     * cloth and some is the photograph of it, and nothing in the archive
     * separates them. So the drawn tooth is put a fifth below the bound, at 6%,
     * which is more contrast than the swatch had and less than the most that
     * could be defended.
     *
     * What has not changed is what the number means. Below about 0.3 the nap
     * starts to read as staining however fine it is, and at 1 the swatch is flat
     * dye again by the other route.
     */
    var ELEVATION = 60;
    var FILL = 0.44;

    function rigVectors() {
        var e = ELEVATION * Math.PI / 180;
        var a = LAY + Math.PI / 2;
        return {
            light: [Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e),
                    Math.sin(e)],
            view: [0, 0, 1],
            fill: FILL
        };
    }

    var VIEWS = {
        cloth: [
            "void main() {",
            "    vec4 p = pile(vUv);",
            "    vec3 c = shade(dye(vUv), fibre(vUv, p.xyz), p);",
            "    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);",
            "}"
        ].join("\n"),

        fibre: [
            "void main() {",
            "    gl_FragColor = vec4(fibre(vUv, pile(vUv).xyz) * 0.5 + 0.5, 1.0);",
            "}"
        ].join("\n"),

        /*
         * The surface normal as a normal map, which is the thing a 3D pipeline
         * actually wants from this file. It is the pile's own relief and not the
         * fibre direction — the two are different maps and the `fibre` view above
         * draws the other one.
         */
        normal: [
            "void main() {",
            "    gl_FragColor = vec4(pile(vUv).xyz * 0.5 + 0.5, 1.0);",
            "}"
        ].join("\n"),

        /*
         * Not a view, a measuring instrument: the shading response on its own,
         * scaled by uBase.x so it fits the 0-1 the framebuffer can hold. `norm`
         * averages it. It is built out of the same `response` as the cloth, so
         * there is no second copy of the model to keep in step.
         *
         * The dither is the whole reason this is a separate program rather than
         * the cloth drawn white. The framebuffer is 8-bit, and averaging an 8-bit
         * render recovers the true mean only when the value varies — then the
         * rounding is scattered and cancels. Where the response is constant, and
         * at 90 degrees of elevation it is exactly constant, every pixel rounds
         * the same way and the error does not cancel at all: it came out as a
         * whole step of colour on the finished swatch, which is the one thing
         * this measurement exists to prevent. Half a step of noise before
         * quantising turns the systematic round back into a scattered one.
         */
        gauge: [
            "void main() {",
            "    vec4 p = pile(vUv);",
            "    float e = response(fibre(vUv, p.xyz), uLight, uView, p)",
            "        * uBase.x;",
            "    float d = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)))",
            "        * 43758.5453) - 0.5;",
            "    gl_FragColor = vec4(vec3(e + d / 255.0), 1.0);",
            "}"
        ].join("\n"),

        lay: [
            "vec3 hue(float h) {",
            "    vec3 k = fract(h + vec3(0.0, 0.6666667, 0.3333333));",
            "    return clamp(abs(k * 6.0 - 3.0) - 1.0, 0.0, 1.0);",
            "}",
            "",
            "void main() {",
            "    vec3 f = fibre(vUv, pile(vUv).xyz);",
            "    gl_FragColor = vec4(hue(atan(f.y, f.x) * 0.1591549 + 0.5), 1.0);",
            "}"
        ].join("\n")
    };

    /*
     * `shade` is in every program rather than only in the one that uses it: the
     * gauge needs `response`, the two debug views need neither, and a GLSL
     * compiler drops what nothing calls. Assembling one list is worth more than
     * saving a function the linker was going to remove anyway.
     */
    function fragment(view) {
        return [PREAMBLE, "", UNIFORMS, "", NOISE, "", materialBody(), "",
                shadeBody(), "", VIEWS[view] || VIEWS.cloth].join("\n");
    }

    /* ---- the one context ---------------------------------------------------
     *
     * One WebGL context for the page, built on first use and never torn down. A
     * context per swatch would be 300 of them against a browser limit of about
     * 16, so the shader draws into a single offscreen canvas and each tile keeps
     * a cheap 2-D canvas to blit into. preserveDrawingBuffer, because every draw
     * here exists to be read straight back out with drawImage.
     *
     * Its own context rather than nap.js's, so that either file can be dropped
     * without disturbing the other while the two are being compared.
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
            canvas.width = MAX_PX;
            canvas.height = MAX_PX;
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
            /*
             * A starting value only. Every draw sets its own — the tile and the
             * popover render at different sizes, and the gauge at a third.
             */
            gl.viewport(0, 0, MAX_PX, MAX_PX);

            ready = true;
            return true;
        } catch (e) {
            gl = null;
            return false;
        }
    }

    /* The program for one view, compiled the first time it is asked for. */
    function program(view) {
        if (programs[view]) { return programs[view]; }
        var prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragment(view)));
        gl.bindAttribLocation(prog, 0, "aPos");
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(prog));
        }
        var entry = { prog: prog, loc: {} };
        ["uBase", "uSeed", "uLight", "uView", "uFill", "uNorm"].forEach(function (u) {
            entry.loc[u] = gl.getUniformLocation(prog, u);
        });
        programs[view] = entry;
        return entry;
    }

    function supported() {
        if (!tried) { init(); }
        return ready;
    }

    /*
     * Everything the first swatch would otherwise pay for, done before one is
     * asked for.
     *
     * The first call to `paint` is not like the ones after it: it builds the
     * context, compiles and links two programs, and runs the gauge, and only
     * then draws. That is about 60ms on a warm driver and a good deal more on a
     * cold one, and all of it used to land on the first tile — which is the one
     * the reader is waiting for. Every tile after it costs a fraction of a
     * millisecond of main thread.
     *
     * None of that work depends on a swatch, so there is no reason for a swatch
     * to be waiting on it. Called at boot, it runs while the product files are
     * still in flight, which is time the page is doing nothing else with.
     *
     * Safe to call more than once and safe to call where WebGL is missing: it
     * asks the same questions `paint` does and gives the same answers.
     */
    function warm() {
        if (!supported()) { return false; }
        try {
            program(VIEW);
            gauge(rigVectors());
            return true;
        } catch (e) {
            return false;
        }
    }

    /* ---- keeping the colour ------------------------------------------------
     *
     * What the shading model's response averages to over a whole tile, so that
     * dividing by it leaves the mean of the tile at exactly the dye.
     *
     * This is the property that makes a lit swatch usable as a colour reference,
     * and it is the whole answer to what was wrong with drawing swatches from
     * photographs. A photograph's cloud is a light that was brighter on one side
     * of the cloth than the other, and no amount of averaging recovers the
     * colour from it because the average is of the lighting too. Here the light
     * is uniform and only the nap varies, so the average of the tile is the
     * average response of the nap — one number, known, and divisible out. A
     * reader looking at a tile is looking at the sampled hex with a texture about
     * it, not near it.
     *
     * Measured off the GPU rather than worked out on paper, for two reasons. The
     * response is a function of the fibre angle and the fibre angle's
     * distribution is whatever the octave sum actually produces — near enough
     * Gaussian to integrate against, but only near enough, and the error would be
     * a quiet bias in every colour on the page. And a second implementation of
     * the shading model in JS to integrate would be a second implementation of
     * the shading model, which would drift from this one the first time either
     * was touched. Rendering the real shader and averaging what comes out has
     * neither problem, and it stays correct on its own when the octaves, the
     * swirl, the tilt or the weights change.
     *
     * Four seeds, because one tile is not the population: the field's broad
     * octave lays only eight cells across a tile, so a single tile's mean carries
     * a little of its own luck. Four of them average that down to well under a
     * step of 8-bit colour, and what is left is reported by the bench rather than
     * assumed away.
     *
     * Cached by rig, since it is a property of the light and not of the swatch.
     */
    var GAUGE = 0.5;
    var GAUGE_SEEDS = [[0, 0], [17.3, 41.9], [33.1, 8.7], [55.4, 24.2]];
    var norms = {};

    /*
     * The gauge draws at its own size rather than at any swatch's, and it is
     * much the smaller.
     *
     * SAMPLES is set by what the *picture* needs: 16 samples a pixel so the
     * fine octave downscales to cloth instead of static. This measurement needs
     * nothing of the kind. It wants a mean and a peak over a whole tile, and a
     * mean over four seeds converges long before four million samples — it is
     * the number of noise cells covered that settles it, and the ladder lays at
     * most 314 across a tile.
     *
     * Measured rather than assumed, against the 2048 figure it used to return:
     *
     *   2048²   mean 0.620075   max 1.050980   267ms
     *   1024²   mean 0.620071   max 1.050980    60ms
     *    512²   mean 0.620208   max 1.050980    23ms
     *    256²   mean 0.620073   max 1.050980    15ms
     *    128²   mean 0.620424   max 1.043137    12ms
     *
     * The peak is bit-identical down to 256² and only gives at 128². The mean
     * moves by 1.3e-4 at 512², which is 0.055 of an 8-bit step on the finished
     * swatch — a twentieth of the smallest difference the framebuffer can hold,
     * and an order below the seed-to-seed spread the four averages away.
     *
     * 512 rather than 256 because the margin is free: both are far inside the
     * error that matters and neither is on the critical path once the cost is
     * 23ms instead of 267ms. That 267ms was the single longest block on the
     * page — it lands on the first tile drawn, so it sat between the reader and
     * the first swatch appearing.
     */
    var GAUGE_PX = 512;

    /*
     * The measurement everything downstream rests on: the mean and the peak of
     * the shading response over a whole tile, read back off the GPU from the
     * real shader.
     *
     * It is taken at uFill = 0, which is the bare directional light and so the
     * material's own response with nothing added. Every other fill follows from
     * it by arithmetic and does not need measuring, because fill enters as
     * `uFill + (1 - uFill) * reach * brdf` — an affine map, and an affine map
     * takes the mean to the mean and the max to the max. So this is one render
     * per geometry rather than one per setting, and `fill` stays free to move.
     *
     * The peak is what the clipping guard below needs and the mean is what the
     * normalisation needs. Reading both off one pass keeps them describing the
     * same cloth.
     */
    function gauge(rig) {
        var key = rig.light.concat(rig.view).map(function (v) {
            return v.toFixed(5);
        }).join(",");
        if (norms[key] !== undefined) { return norms[key]; }

        var p = program("gauge");
        gl.useProgram(p.prog);
        gl.uniform3f(p.loc.uBase, GAUGE, GAUGE, GAUGE);
        gl.uniform3f(p.loc.uLight, rig.light[0], rig.light[1], rig.light[2]);
        gl.uniform3f(p.loc.uView, rig.view[0], rig.view[1], rig.view[2]);

        /*
         * The whole tile, drawn small: vUv runs 0-1 across the viewport
         * whatever its size, so this is the same piece of cloth at a coarser
         * sampling and not a corner of it. Put back afterwards, because `paint`
         * takes the viewport as it finds it.
         */
        gl.viewport(0, 0, GAUGE_PX, GAUGE_PX);

        var px = new Uint8Array(GAUGE_PX * GAUGE_PX * 4);

        function measure(fill) {
            gl.uniform1f(p.loc.uFill, fill);
            var total = 0;
            var peak = 0;
            GAUGE_SEEDS.forEach(function (s) {
                gl.uniform2f(p.loc.uSeed, s[0], s[1]);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                gl.readPixels(0, 0, GAUGE_PX, GAUGE_PX, gl.RGBA,
                              gl.UNSIGNED_BYTE, px);
                var sum = 0;
                var hi = 0;
                for (var i = 0; i < px.length; i += 4) {
                    sum += px[i];
                    if (px[i] > hi) { hi = px[i]; }
                }
                total += sum / (px.length / 4) / 255 / GAUGE;
                peak = Math.max(peak, (hi + 1) / 255 / GAUGE);
            });
            return { mean: total / GAUGE_SEEDS.length, max: peak };
        }

        norms[key] = measure(0);
        gl.viewport(0, 0, MAX_PX, MAX_PX);
        return norms[key];
    }

    /* Where a given fill puts the mean and the peak, off that one measurement. */
    function level(g, fill) {
        return {
            mean: fill + (1 - fill) * g.mean,
            max: fill + (1 - fill) * g.max
        };
    }

    /*
     * What a swatch has to be lit with for it to still be the colour it says.
     *
     * A highlight on a near-white cloth has nowhere to go. The contract here is
     * that the tile's mean IS the sampled hex, and that only holds while nothing
     * clips: the moment the bright tail runs past 255 the top of the
     * distribution is thrown away, the mean falls below the hex, and the swatch
     * quietly stops being a colour reference. Country Cream, at 249, was out by
     * 4.3 steps the first time the pile was given a surface — the relief had
     * added a highlight the colour had no room for.
     *
     * Clamping is not a fix, because the thing being clamped is the measurement.
     * What gives instead is the lighting: more of the light arrives from no
     * direction, the peak comes down, and the cloth still reads as cloth with a
     * quieter nap. Which is also what the photographs show — a cream swatch has
     * visibly less tonal range than a navy one, for exactly this reason and not
     * because the cloth differs.
     *
     * So FILL is a floor rather than a setting. Most colours sit on it. The few
     * light enough to need headroom get the least extra fill that buys it, and
     * nothing anywhere in the library clips.
     */
    function fillFor(rig, entry) {
        var rgb = rgbOf(entry);
        if (!rgb) { return rig.fill; }
        var c = Math.max(rgb[0], rgb[1], rgb[2]) / 255;
        var g = gauge(rig);

        function clips(f) {
            var at = level(g, f);
            return at.mean <= 0 || c * at.max / at.mean > 1;
        }
        if (!clips(rig.fill)) { return rig.fill; }

        var lo = rig.fill;
        var hi = 1;
        for (var i = 0; i < 24; i += 1) {
            var m = (lo + hi) / 2;
            if (clips(m)) { lo = m; } else { hi = m; }
        }
        return hi;
    }

    function norm(rig) {
        var mean = level(gauge(rig), rig.fill).mean;
        return mean > 0 ? 1 / mean : 1;
    }

    /* ---- per-swatch inputs ------------------------------------------------- */

    function rgbOf(entry) {
        if (entry.rgb) { return entry.rgb; }
        var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(entry.hex || "");
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
    }

    /*
     * The seed only has to be stable and well spread — the same swatch draws the
     * same piece of cloth on every visit, and no two swatches draw the same
     * piece. It is a whole-period offset into a field that wraps, so it moves
     * which part of the bolt is on screen without ever costing the tiling.
     */
    function seed(key) {
        var h = 2166136261;
        for (var i = 0; i < key.length; i += 1) {
            h ^= key.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        return [(h & 0xffff) / 65536 * 64, ((h >>> 16) & 0xffff) / 65536 * 64];
    }

    /*
     * Whether this shader has what it needs to draw an entry.
     *
     * A colour, and a `nap` block — not for its numbers, which are not read
     * here, but because its presence is how a file says "this is plain dyed
     * cloth". The Light Jungle prints have none, and a printed animal pattern is
     * not a dye with a texture over it: drawing one as a flat colour would be
     * worse than showing its photograph. When this shader grows inputs of its
     * own, that is what this should ask for instead.
     */
    function has(entry) {
        return Boolean(entry && entry.nap) && rgbOf(entry) !== null;
    }

    /* ---- drawing ----------------------------------------------------------- */

    /*
     * Renders `entry` into `target`, a 2-D canvas, at `size` device pixels
     * square. Returns false if there is nothing to draw with, so the caller can
     * fall back to the photograph or the flat hex.
     *
     * `product` is what the entry does not know about itself. Nothing is read
     * out of it yet, and by design little should be: the per-product corrections
     * the first shader carries are corrections to six different cameras, and
     * this shader is not looking through any of them.
     */
    function paint(target, entry, size, product) {
        var rgb = rgbOf(entry);
        if (!has(entry) || !supported()) { return false; }

        var s = seed(entry.slug || entry.name || "");
        var p;
        try {
            p = program(VIEW);
        } catch (e) {
            return false;
        }

        var rig = rigVectors();
        rig.fill = fillFor(rig, entry);
        var k = norm(rig);

        gl.useProgram(p.prog);
        gl.uniform3f(p.loc.uBase, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        gl.uniform2f(p.loc.uSeed, s[0], s[1]);
        gl.uniform3f(p.loc.uLight, rig.light[0], rig.light[1], rig.light[2]);
        gl.uniform3f(p.loc.uView, rig.view[0], rig.view[1], rig.view[2]);
        gl.uniform1f(p.loc.uFill, rig.fill);
        gl.uniform1f(p.loc.uNorm, k);

        var px = renderPx(size);
        gl.viewport(0, 0, px, px);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        target.width = size;
        target.height = size;
        var ctx = target.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        /*
         * The viewport fills the bottom-left of the canvas, because GL counts
         * from the bottom and the canvas stays at the cap rather than being
         * resized per draw — resizing reallocates the drawing buffer, which is
         * the one thing here that would cost more than it saved. drawImage
         * counts from the top, so the source rectangle is offset by whatever
         * the viewport did not use.
         */
        ctx.drawImage(gl.canvas, 0, MAX_PX - px, px, px, 0, 0, size, size);
        return true;
    }

    /*
     * The same shader with this swatch's inputs frozen into it, as text, and
     * nothing else in it at all.
     *
     * A swatch here is a number and a recipe rather than a picture, and both
     * halves should be takeable: the constants below are the whole of what makes
     * this colour this colour, so the listing runs anywhere a fragment shader
     * runs without lt.json or any of this page. Which is the reason it carries
     * no header and no commentary — what is copied is a shader, and it is going
     * into a file that compiles it or an editor that runs it, neither of which
     * wants this file's reasoning pasted at the top. The reasoning is here, and
     * here is where it stays.
     *
     * It needs no WebGL to produce — an entry has a shader to give whether or
     * not this browser can draw it.
     */
    function source(entry, opts) {
        var rgb = rgbOf(entry);
        if (!has(entry)) { return null; }

        var s = seed(entry.slug || entry.name || "");

        function vec(values, digits) {
            return "vec" + values.length + "(" + values.map(function (v) {
                return v.toFixed(digits);
            }).join(", ") + ")";
        }

        /*
         * The rig goes in as constants like everything else, so the listing is a
         * whole swatch rather than a shader with four holes in it. A reader
         * putting this on a model replaces the two vectors with their own and
         * remeasures uNorm, and the note in the bench says how.
         */
        var rig = rigVectors();
        if (supported()) { rig.fill = fillFor(rig, entry); }
        var consts = [
            "const vec3 uBase = " + vec([rgb[0] / 255, rgb[1] / 255,
                rgb[2] / 255], 6) + ";",
            "const vec2 uSeed = " + vec(s, 4) + ";",
            "const vec3 uLight = " + vec(rig.light, 6) + ";",
            "const vec3 uView = " + vec(rig.view, 6) + ";",
            "const float uFill = " + rig.fill.toFixed(6) + ";",
            "const float uNorm = " +
                (supported() ? norm(rig) : 1).toFixed(6) + ";"
        ].join("\n");

        return [PREAMBLE, "", consts, "", NOISE, "", materialBody(), "",
                shadeBody(), "", VIEWS[VIEW] || VIEWS.cloth, ""].join("\n");
    }

    return {
        paint: paint,
        source: source,
        supported: supported,
        warm: warm,
        has: has,
        fragment: fragment,
        view: function (name) {
            if (name && VIEWS[name] && name !== "gauge") { VIEW = name; }
            return VIEW;
        },
        /* what shape the nap takes: degrees, 90 being flat dye */
        elevation: function (deg) {
            if (typeof deg === "number") { ELEVATION = deg; }
            return ELEVATION;
        },
        /* how loud it is: 0 is one bare lamp, 1 is flat dye by the other route */
        fill: function (v) {
            if (typeof v === "number") { FILL = v; }
            return FILL;
        },
        /*
         * How big a clump is, in millimetres of cloth. This one is not a
         * uniform — it is written into the shader source — so the compiled
         * programs go, and the measured means with them, since the mean
         * response of a field depends on the field.
         */
        grain: function (mm) {
            if (typeof mm === "number" && mm > 0 && mm !== GRAIN_MM) {
                GRAIN_MM = mm;
                programs = {};
                norms = {};
            }
            return GRAIN_MM;
        },
        /*
         * How far the top of the pile tips, as a slope gain. Written into the
         * shader like the grain, so both caches go.
         */
        bump: function (v) {
            if (typeof v === "number" && v !== BUMP) {
                BUMP = v;
                programs = {};
                norms = {};
            }
            return BUMP;
        },
        /* how wide a clump of pile is, in mm — the coarse end of the height */
        tuft: function (mm) {
            if (typeof mm === "number" && mm > 0 && mm !== TUFT_MM) {
                TUFT_MM = mm;
                programs = {};
                norms = {};
            }
            return TUFT_MM;
        },
        /* how far the lean's lattice is jittered, in tile units per unit of slope */
        scatter: function (v) {
            if (typeof v === "number" && v !== SCATTER) {
                SCATTER = v;
                programs = {};
                norms = {};
            }
            return SCATTER;
        },
        /* how far the lean turns uphill: radians of turn per unit of slope */
        clump: function (v) {
            if (typeof v === "number" && v !== CLUMP) {
                CLUMP = v;
                programs = {};
                norms = {};
            }
            return CLUMP;
        },
        /* how deep it is: optical depth per standard deviation of height */
        depth: function (v) {
            if (typeof v === "number" && v !== DEPTH) {
                DEPTH = v;
                programs = {};
                norms = {};
            }
            return DEPTH;
        },
        /* what the two ladders came out as: cycles across a tile, and in mm */
        band: function () {
            function rungs(mm) {
                return octaves(mm).map(function (o) {
                    return {
                        cycles: o.cycles,
                        mm: TILE_MM / o.cycles,
                        weight: o.weight,
                        px: LADDER_PX / o.cycles
                    };
                });
            }
            return { lean: rungs(GRAIN_MM), pile: rungs(TUFT_MM) };
        }
    };
}());
