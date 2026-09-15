/*
 * Synthetic Suede Fabric Library — the nap shader.
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
 * One WebGL context does the whole page. A context per swatch would be 49 of
 * them against a browser limit of about 16, so the shader draws into a single
 * offscreen canvas and each tile keeps a cheap 2-D canvas to blit into.
 */

var Nap = (function () {
    "use strict";

    /*
     * The five octaves the photographs decompose into, as cycles across the
     * frame, and how much of `contrast` each one draws.
     *
     * There is no octave finer than 100 cycles, and that is the whole
     * difference between cloth and tyre tread. Measured raw, 80% of a swatch's
     * variance sits in a pixel-scale band — but that band's horizontal lag-1
     * autocorrelation is *negative*, which is the signature of sensor and JPEG
     * noise rather than of a surface. Drawing a camera's noise budget as a
     * coherent noise field is what made an earlier pass of this shader read as
     * sharp directional streaks. It is measured out now and not drawn.
     *
     * What is left is broad and gentle: of the structural variation, a fine
     * mottle at 100 cycles carries 45% and a cloud slower than 3 carries 36%,
     * with a thin tail between (NAP_WEIGHTS in build_dataset.py).
     *
     * These are not quite those numbers. Three things are folded in that only
     * show up once the field is actually drawn: a three-cycle octave realises
     * noticeably less variance inside any one frame than its ensemble variance,
     * so the broad end is worth more here than the spectrum says; SHEEN takes a
     * share below; and the finest octave sits at 180 cycles rather than the
     * measured 100.
     *
     * That last one is the only place this deliberately leaves the measurement.
     * At 100 cycles the mottle is a five-pixel cell — the finest thing the field
     * has, and so the finest thing on screen — and a swatch whose smallest
     * feature is five pixels reads as low resolution however hard it is
     * sharpened. 180 is about where a feature stops surviving the scale down to
     * the display, so it is the finest the field can usefully be. It is the same
     * octave moved, not a new band: drawing the camera's pixel-scale noise as a
     * sixth layer is what made an earlier pass read as tyre tread, and that is
     * still measured out. Rendered against all 30 large captures the move takes
     * the fine band from 0.48x to 0.77x of the photographs and the structural
     * band from 1.13x to 0.97x — closer on both.
     */
    var OCTAVES = [
        { freq: 180, weight: 0.4155, split: true },
        { freq: 40, weight: 0.2001 },
        { freq: 17, weight: 0.1346 },
        { freq: 7, weight: 0.1451 },
        { freq: 3, weight: 0.7495, split: true }
    ];

    /*
     * The last of the broad band the octaves cannot supply, as a fraction of
     * the whole contrast.
     *
     * Noise alone comes out at 0.77 of the photographs' broad band, and the
     * shortfall is not an error in the weights — it is a smooth gradient across
     * the frame, the studio's raking light, which no amount of noise makes.
     * An orthogonal component of 0.64 of that band closes the gap, and 0.64 of
     * a band that is itself 0.61 of the total is this number. The octaves are
     * scaled by the remainder, so the two combine in quadrature rather than
     * one being added on top of a field that was already the right size.
     *
     * The direction is deliberately the same for every swatch: consistent
     * raking light looks like a lighting set-up, varied light looks like a bug.
     */
    var SHEEN = 0.394;
    var SHEEN_DIR = [0.62, -0.78];

    /*
     * Everything is drawn at this size and scaled down to whatever the caller
     * asked for, rather than drawn at the asked-for size directly — so a tile
     * and the popover's large view are the same fabric at two magnifications
     * rather than two different fabrics.
     *
     * 512 carries the finest octave with room to spare: 180 cycles across the
     * frame is a three-pixel mottle here, and the popover shows the frame at
     * about 524 device pixels, so what is drawn is what is displayed. Rendering
     * larger was tried and measured — at 1024 and at 2048 the fine band at
     * display size came out 0.481x and 0.478x against 512's 0.483x, which is to
     * say identical and then slightly worse. The softness was never the raster.
     */
    var RENDER_PX = 512;

    /*
     * Standard deviation of one octave of quintic-interpolated value noise over
     * a uniform hash.
     */
    var NOISE_SD = 0.2247;

    /*
     * Rotations, one per noise layer, so no two lattices ever line up. They are
     * irrational fractions of a turn, so they do not agree with each other
     * either.
     */
    var ROT = [0.358, 1.068, -0.680, 1.700, 2.443, 0.912, -1.235];

    /*
     * Sharpening: how much of the difference between the field and a blur of it
     * to add back, and the blur's radius.
     *
     * The radius is one cell of the finest octave, expressed in UV rather than
     * in pixels so it follows that octave rather than the raster — the mask has
     * to sit on the scale the field actually has content at, and if it were
     * pinned to a pixel count it would drift off that scale the moment either
     * number changed.
     */
    var SHARPEN = 3.5;
    var SHARPEN_R = (1.0 / OCTAVES[0].freq).toFixed(6);

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
     * The octave sum, written out from OCTAVES. Every layer takes its own
     * offset from the seed rather than sharing an origin, so no two swatches
     * line up and no octave pins its features to the same corner of every tile.
     *
     * The two ends of the spectrum are each split into a pair of layers at
     * incommensurate frequencies and different angles, for opposite reasons:
     * the finest is the one octave where a single lattice would still be
     * legible however it is turned, and the broadest lays only three cells
     * across the frame, few enough that one layer's cell corners would show as
     * the shape of the cloud. 0.7071 keeps a pair at the variance of one.
     */
    function octaveSum() {
        var rot = 0;
        var lines = OCTAVES.map(function (o, i) {
            function layer(freq) {
                var n = rot;
                rot += 1;
                /* .yx on alternate layers so no two share an offset either */
                return "vnoise(" + mat2(ROT[n]) + " * p * " + freq.toFixed(1) +
                    " + uSeed" + (n % 2 ? ".yx" : "") + " * " +
                    (1.0 + n * 0.7).toFixed(1) + ")";
            }
            var term = layer(o.freq);
            if (o.split) {
                term = "0.7071 * (" + term + "\n            + " +
                    layer(o.freq * 1.31) + ")";
            }
            return "        " + (i ? "+ " : "  ") + o.weight.toFixed(4) +
                " * " + term;
        });
        return "    return (\n" + lines.join("\n") + "\n    ) / " +
            NOISE_SD.toFixed(4) + ";";
    }

    /*
     * Everything below the four inputs. Kept apart from them because the page
     * and the copyable listing differ only in how those four arrive: the live
     * program takes them as uniforms, and a copied shader has them baked in as
     * constants. One body, so the code on the clipboard is the code that drew
     * the swatch the reader is looking at rather than a paraphrase of it.
     */
    var BODY = [
        "float hash(vec2 p) {",
        "    p = fract(p * vec2(127.317, 311.7));",
        "    p += dot(p, p + 34.71);",
        "    return fract(p.x * p.y);",
        "}",
        "",
        /*
         * Value noise, centred on zero. The interpolant is quintic rather than
         * the usual smoothstep: smoothstep leaves a kink in the first
         * derivative at every cell boundary, and a field of those kinks lines
         * up into a visible square lattice — which on a fabric swatch reads
         * unmistakably as a woven crosshatch. Suede is not woven. The quintic
         * is flat to the second derivative at the boundary and it goes away.
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
         * No directional stretch. Measured band by band, everything from 2px up
         * is isotropic to within a few percent; the 19% anisotropy an earlier
         * pass stretched the whole field by belonged to the discarded noise
         * band, which is to say to JPEG rather than to the nap.
         */
        "float field(vec2 p) {",
        octaveSum(),
        "}",
        "",
        "void main() {",
        /*
         * An unsharp mask, on the field rather than on the pixels.
         *
         * The field is drawn at RENDER_PX and scaled to whatever the caller
         * asked for, and the browser scales it again fitting the canvas into
         * its CSS box; both are blurs, and the photographs go through neither.
         * This puts that edge back. Sampling the four neighbours costs four
         * more evaluations of the field, which is nothing on a GPU and is why
         * this is here rather than as a convolution over the finished pixels —
         * the same mask written in JS took 680ms to fill the grid.
         *
         * The radius is the finest octave's own cell size — the finest thing
         * the field has, and so the only thing there is to sharpen. It takes an
         * amount this large to show, because an unsharp mask can only lift what
         * is already in the field; it puts an edge on the mottle, it does not
         * add texture below it. Which is why the mottle had to move as well:
         * past about 4.5 this stops reading as a sharper nap and starts reading
         * as speckle, and it pulls the structural band up with it.
         */
        "    float t = field(vUv);",
        "    float lo = 0.25 * (field(vUv + vec2(" + SHARPEN_R + ", 0.0))",
        "                     + field(vUv - vec2(" + SHARPEN_R + ", 0.0))",
        "                     + field(vUv + vec2(0.0, " + SHARPEN_R + "))",
        "                     + field(vUv - vec2(0.0, " + SHARPEN_R + ")));",
        "    t += " + SHARPEN.toFixed(2) + " * (t - lo);",
        "",
        /*
         * A plain ramp, because that is what a distant source looks like across
         * a swatch this size. Dotted with a unit direction over the unit square
         * it has a standard deviation of 1/sqrt(12), so scaling by sqrt(12)
         * leaves it at unit variance like `t` — and the two coefficients then
         * combine in quadrature to exactly 1.
         */
        "    float sheen = dot(vUv - 0.5, vec2(" + SHEEN_DIR[0].toFixed(2) +
            ", " + SHEEN_DIR[1].toFixed(2) + ")) * 3.4641;",
        "",
        "    vec3 c = uBase + uAxis * uContrast * (t * " +
            Math.sqrt(1 - SHEEN * SHEEN).toFixed(4) + " + sheen * " +
            SHEEN.toFixed(3) + ");",
        "    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);",
        "}"
    ].join("\n");

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

    var FRAG = [PREAMBLE, UNIFORMS, "", BODY].join("\n");

    /* ---- the one context ---------------------------------------------------
     *
     * Built on first use and never torn down: whichever swatch asks first pays
     * for the compile, and the other 48 draw for the cost of four uniform
     * uploads. preserveDrawingBuffer, because every draw here exists to be
     * read straight back out with drawImage.
     */

    var gl = null;
    var prog = null;
    var loc = {};
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

            prog = gl.createProgram();
            gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
            gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
            gl.bindAttribLocation(prog, 0, "aPos");
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
                throw new Error(gl.getProgramInfoLog(prog));
            }
            gl.useProgram(prog);

            /* one triangle, big enough to cover the frame */
            var buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.viewport(0, 0, RENDER_PX, RENDER_PX);

            ["uBase", "uAxis", "uContrast", "uSeed"].forEach(function (name) {
                loc[name] = gl.getUniformLocation(prog, name);
            });

            ready = true;
            return true;
        } catch (e) {
            gl = null;
            return false;
        }
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
     * Every swatch is the same four uniforms and one triangle, so all 49 of
     * them cost one shader compile between them.
     */
    function paint(target, entry, size) {
        var rgb = rgbOf(entry);
        if (!rgb || !entry.nap || !supported()) { return false; }

        var nap = entry.nap;
        var s = seed(entry.slug || entry.name || "");

        gl.uniform3f(loc.uBase, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        gl.uniform3f(loc.uAxis, nap.axis[0], nap.axis[1], nap.axis[2]);
        gl.uniform1f(loc.uContrast, nap.contrast / 255);
        gl.uniform2f(loc.uSeed, s[0], s[1]);

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
     */
    function source(entry) {
        var rgb = rgbOf(entry);
        if (!rgb || !entry.nap) { return null; }

        var nap = entry.nap;
        var s = seed(entry.slug || entry.name || "");

        function vec(values, digits) {
            return "vec" + values.length + "(" + values.map(function (v) {
                return v.toFixed(digits);
            }).join(", ") + ")";
        }

        /*
         * A header, because this leaves the page and arrives somewhere with no
         * context at all — a scratch file, a shader editor, a paste into a
         * message. It should say what it draws and where the numbers came from.
         */
        var id = entry.sku || entry.code;
        var head = [
            "// Ultrasuede LT — " + entry.name + (id ? " (" + id + ")" : ""),
            "//",
            "// The nap shader from the Ultrasuede Color Library page, with this",
            "// swatch's sampled numbers frozen in. Fragment shader; vUv runs the",
            "// unit square."
        ].join("\n");

        var consts = [
            "const vec3 uBase = " + vec([rgb[0] / 255, rgb[1] / 255,
                rgb[2] / 255], 6) + ";  // median colour, 0-1",
            "const vec3 uAxis = " + vec(nap.axis, 6) +
                ";  // luminance-normalised RGB direction",
            "const float uContrast = " + (nap.contrast / 255).toFixed(6) +
                ";  // standard deviation, 0-1",
            "const vec2 uSeed = " + vec(s, 4) + ";"
        ].join("\n");

        return [head, "", PREAMBLE, "", consts, "", BODY, ""].join("\n");
    }

    return { paint: paint, source: source, supported: supported };
}());
