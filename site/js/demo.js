/*
 * Footbag Fabric Library — demo page.
 *
 * Reads one JSON file per product, renders each product's subsections as swatch
 * grids, and fills a single shared popover with the entry that was clicked.
 */

(function () {
    "use strict";

    var popover = document.getElementById("swatch-detail");
    var head = document.getElementById("detail-head");
    var media = document.getElementById("detail-media");
    var body = document.getElementById("detail-body");
    /* The column that scrolls, now that the panel around it does not. */
    var detail = popover.querySelector(".detail");

    /*
     * Render sizes in device pixels, fixed rather than measured. A tile is
     * about 117 CSS pixels at six across, so 256 covers a 2x screen, and the
     * popover's image column is about 270.
     */
    var TILE_PX = 256;
    var DETAIL_PX = 512;

    /*
     * Which of the two the popover is showing. Reset on every open rather than
     * carried over: the choice belongs to the swatch being looked at, not to the
     * reader, and a sticky setting means the next swatch opens on whichever of
     * the two it happens to have.
     *
     * What it resets to is the shader, for every product. This used to be a
     * per-product flag: LX's and ST's photographs are large and clean — 800px
     * storefront frames and 418px Toray swatches, against LT's 100px archived
     * thumbnails — and on their own merits they are the better picture, so
     * those two opened on the photo. But the grid is one page, and a reader
     * scrolling it was crossing between two kinds of image with no warning:
     * six products in a row, two of them lit and folded and four of them flat.
     * What the archive is for is comparing colours across the six, and the
     * shader is the only rendering all six share. So the shader leads
     * everywhere, and the photograph is one click away in the panel.
     */
    var showPhoto = false;

    /* ---- small DOM helpers ------------------------------------------------ */

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text != null) { node.textContent = text; }
        return node;
    }

    function clear(node) {
        while (node.firstChild) { node.removeChild(node.firstChild); }
    }

    /*
     * Lucide's copy glyph, built rather than pasted in as markup — the page has
     * one icon in it, and one icon does not earn a sprite sheet, a fetch or the
     * only innerHTML in the file.
     *
     * Sized and coloured entirely from CSS, so the width and height attributes
     * the source carries are deliberately left off: they map to presentation
     * attributes, which is a specified width, and a specified width is one
     * aspect-ratio cannot then work around.
     */
    var SVG_NS = "http://www.w3.org/2000/svg";

    function copyIcon() {
        var svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("class", "copy-icon");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        /* the button says what it does in words beside it */
        svg.setAttribute("aria-hidden", "true");

        var rect = document.createElementNS(SVG_NS, "rect");
        rect.setAttribute("x", "8");
        rect.setAttribute("y", "8");
        rect.setAttribute("width", "14");
        rect.setAttribute("height", "14");
        rect.setAttribute("rx", "2");
        rect.setAttribute("ry", "2");
        svg.appendChild(rect);

        var path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d",
            "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2");
        svg.appendChild(path);

        return svg;
    }

    /* ---- copying -----------------------------------------------------------
     *
     * navigator.clipboard is only there in a secure context, which this page is
     * over localhost but is not over a plain http host — so the old
     * selection-and-execCommand route stays as the fallback. It is deprecated
     * rather than gone, and "deprecated" beats "the button does nothing".
     */

    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text).then(function () {
                return true;
            }, function () {
                return legacyCopy(text);
            });
        }
        return Promise.resolve(legacyCopy(text));
    }

    function legacyCopy(text) {
        var area = el("textarea");
        area.value = text;
        /* off-screen rather than hidden: a display:none field cannot be selected */
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try {
            ok = document.execCommand("copy");
        } catch (e) {
            ok = false;
        }
        document.body.removeChild(area);
        return ok;
    }

    /*
     * Wires a control up to copy `text()`.
     *
     * Nothing is drawn in acknowledgement: the buttons say what they do, and a
     * badge appearing and timing out beside the value is more movement than a
     * copy is worth. The announcement stays, because it is the only way the
     * copy is perceivable at all without sight of the clipboard.
     */
    function copyOnClick(button, text, what) {
        button.addEventListener("click", function () {
            copyText(text()).then(function (ok) {
                if (ok) { say(what + " copied"); }
            });
        });
        return button;
    }

    /*
     * One polite live region for the whole page. Cleared first so copying the
     * same thing twice is announced twice rather than once.
     */
    var announcer = null;

    function say(message) {
        if (!announcer) {
            announcer = el("div", "visually-hidden");
            announcer.setAttribute("role", "status");
            announcer.setAttribute("aria-live", "polite");
            document.body.appendChild(announcer);
        }
        announcer.textContent = "";
        setTimeout(function () { announcer.textContent = message; }, 50);
    }

    /*
     * A link out. Archive URLs are long and say nothing useful in full, so the
     * caller passes the label — for the list of sightings, the capture date.
     */
    function link(url, label) {
        var a = el("a", null, label || url);
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        return a;
    }

    /* ---- swatch media ------------------------------------------------------
     *
     * A swatch can be drawn three ways, in this order of preference: the nap
     * shader, the archived photograph, a flat fill of the sampled hex.
     *
     * The shader comes first because the photographs are the weakest thing in
     * the dataset — 100px thumbnails, some of them JPEG mush, eighteen of them
     * watermarked across the middle, and six no bigger than 57px square —
     * while the numbers sampled out of them are clean. It falls back on its own
     * if WebGL is missing.
     *
     * The Light Jungle patterns are printed rather than piece-dyed and carry no
     * nap block, so they keep their photograph: an animal print is not a colour
     * with a texture over it, and there is nothing here that could invent one.
     */

    function canRender(entry) {
        return Boolean(entry.nap) && Nap.supported();
    }

    function photoOf(entry) {
        return entry.image_large || entry.image || null;
    }

    /*
     * Nothing to draw: no shader, no photograph, not even a sampled colour.
     * That is what the missing-image section is, and it is the entry that says
     * so rather than the section it happens to be listed in — which is how the
     * one Bobcat colourway Toray never captured ends up in a list that is
     * otherwise colours.
     */
    function blank(entry) {
        return !canRender(entry) && !photoOf(entry) && !entry.hex;
    }

    /*
     * Whether an entry is drawn at all. Kept out of blank() because it is a
     * different question: blank() asks what an entry has, this asks whether the
     * record wants it shown. An entry the file marks on_page: false keeps
     * everything it has and simply is not rendered — see off_page_reason.
     */
    function onPage(entry) {
        return entry.on_page !== false;
    }

    function napCanvas(entry, size, label, product) {
        var canvas = el("canvas", "swatch-render");
        if (!Nap.paint(canvas, entry, size, product)) {
            return null;
        }
        if (label) {
            canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", label);
        } else {
            /* the tile says the name in text right underneath */
            canvas.setAttribute("aria-hidden", "true");
        }
        return canvas;
    }

    /*
     * `src` is left off entirely when there is none yet — an <img src=""> is a
     * request for the page itself, not an empty image.
     */
    function photoImg(entry, src, lazy) {
        var img = el("img");
        if (src) { img.src = src; }
        img.alt = entry.name;
        if (lazy) { img.loading = "lazy"; }
        return img;
    }

    /* ---- drawing the grid late -------------------------------------------- *
     *
     * The page is six products and about 300 swatches, and it is 11,000 pixels
     * tall: eighteen tiles are on the first screen and the other 280 are work
     * done for a reader who may never scroll. Drawn all at once that is ~180ms
     * of blocked main thread and, worse, ~74MB of canvas backing store handed
     * to the compositor before anything appears — a canvas costs its pixels the
     * moment it is drawn into, and 297 of them at 256px square is most of what
     * stands between the fetch finishing and the page being there.
     *
     * So a tile's picture is made when the tile is nearly on screen instead.
     * The well is already the swatch's sampled colour underneath, so the thing
     * that arrives is texture over the right colour rather than a blank filling
     * in, and NEAR is a screenful and a half of warning — far enough that
     * scrolling never catches one being drawn.
     *
     * The first screenful is drawn synchronously rather than through the
     * observer: its callback lands a frame late, which is a frame of flat
     * colour at the top of the page for no reason.
     */

    var NEAR = "900px";

    /* canvas or img -> the entry it is waiting to become */
    var pending = new Map();
    var watcher = null;

    function drawPending(node) {
        var item = pending.get(node);
        if (!item) { return; }
        pending.delete(node);

        if (item.photo) {
            node.src = item.photo;
            return;
        }

        if (Nap.paint(node, item.entry, TILE_PX, item.product)) {
            return;
        }

        /*
         * The shader had its inputs and still could not draw — a context lost
         * between boot and here, or a weave whose program would not compile.
         * Fall back the way tile() would have if it had known, which it could
         * not: nothing about an entry says whether its program links.
         */
        node.parentNode.removeChild(node);
        if (item.fallback) {
            item.well.appendChild(photoImg(item.entry, item.fallback, true));
        } else {
            item.well.style.backgroundColor = item.entry.hex;
        }
    }

    /*
     * Called once, after every section is in the document — which is the first
     * moment a tile has a position to be near or far from.
     */
    function drawTiles() {
        if (!window.IntersectionObserver) {
            Array.from(pending.keys()).forEach(drawPending);
            return;
        }

        watcher = new IntersectionObserver(function (rows) {
            rows.forEach(function (row) {
                if (!row.isIntersecting) { return; }
                watcher.unobserve(row.target);
                drawPending(row.target);
            });
        }, { rootMargin: NEAR });

        var reach = window.innerHeight * 1.5;
        Array.from(pending.keys()).forEach(function (node) {
            if (node.getBoundingClientRect().top < reach) {
                drawPending(node);
            } else {
                watcher.observe(node);
            }
        });
    }

    /*
     * The identifier, the same string on the tile and in the popover's subtitle.
     *
     * A colour carries a full SKU (8801-2467); a Field's custom colour was never
     * given one and carries the bare colour number it is ordered by; a pattern
     * is a pattern number and a colourway, written pattern-colour to match the
     * shape of the SKU rather than spelled out.
     */
    function codeOf(entry, kind) {
        if (kind === "pattern") { return entry.pattern + "-" + entry.color; }
        return entry.sku || entry.code || "";
    }


    /* ---- tiles ------------------------------------------------------------ */

    /*
     * Every entry becomes the same tile: a square well, a name and a code line.
     * The well falls back to the sampled hex where there is neither a shader nor
     * a photo, so an entry with no archived image still reads as a tile rather
     * than a hole in the grid.
     */
    /*
     * A colour that has no colour: a name and its number, and nothing else. It
     * deliberately does not get the square well the swatches have — a grid of
     * empty wells would read as a grid of images that failed to load, and what
     * is missing here is the picture, not the loading of it. The dates stay in
     * the panel, where the list of sightings gives them somewhere to mean
     * something.
     */
    function record(entry, kind) {
        /*
         * A plain block rather than a button: there is no picture to open, so
         * there is nothing for a press to do. It was a control, and a control
         * that opens a panel of nothing much is a promise the tile cannot keep
         * — so the affordances go with it, and the pointer, the hover wash and
         * the focus ring are all off in the stylesheet.
         */
        var item = el("div", "record");

        var text = el("span", "swatch-text");
        text.appendChild(el("span", "swatch-name", entry.name));
        text.appendChild(el("span", "swatch-code", codeOf(entry, kind)));
        item.appendChild(text);

        return item;
    }

    function tile(entry, kind, product) {
        if (blank(entry)) { return record(entry, kind); }

        var button = el("button", "swatch");
        button.type = "button";

        var well = el("span", "swatch-thumb");
        /*
         * photoOf, not entry.image: the small copy is 100px and the well is
         * about 117 CSS pixels, so on a 3x screen the small one is a 3.5x
         * upscale and reads as blurred.
         */
        var photo = photoOf(entry);
        /*
         * The shader leads in the grid for every product — see showPhoto — so
         * the tile and the panel it opens agree on which side they start on.
         * The photograph is what is left for the entries that have no shader to
         * draw: the Light Jungle prints, which carry no nap block.
         */
        if (canRender(entry)) {
            /*
             * Sized but not drawn — see drawTiles. An undrawn canvas has no
             * context and so no pixels behind it, which is the whole saving;
             * what stands in the well until then is the sampled colour, set on
             * the well rather than the canvas so it survives the fallback.
             */
            var canvas = el("canvas", "swatch-render");
            canvas.setAttribute("aria-hidden", "true");
            well.style.backgroundColor = entry.hex || "";
            well.appendChild(canvas);
            pending.set(canvas, {
                entry: entry, product: product, well: well, fallback: photo
            });
        } else if (photo) {
            /*
             * Held back by the same observer as the shader tiles rather than by
             * loading="lazy". The attribute is a hint and Chrome reads it
             * generously: every one of these seventeen prints was fetched on
             * load, 350KB of pictures three screens down the page.
             */
            var img = photoImg(entry, "", false);
            well.appendChild(img);
            pending.set(img, { entry: entry, photo: photo });
        } else {
            well.style.backgroundColor = entry.hex;
        }
        button.appendChild(well);

        /*
         * Name over identifier. All three shapes are numeric and hyphenated the
         * same way — 8801-2467, 181-023, 1419 — so one code face carries them
         * all and the line reads as the same kind of thing across the page.
         *
         * Patterns need theirs most of all: six
         * of the eleven Light Jungle patterns were sold in two colourways, so a
         * name on its own puts two tiles reading "Bobcat" next to each other
         * and they look like a bug in the data rather than what they are.
         */
        var text = el("span", "swatch-text");
        text.appendChild(el("span", "swatch-name", entry.name));
        text.appendChild(el("span", "swatch-code", codeOf(entry, kind)));
        button.appendChild(text);

        button.addEventListener("click", function () {
            show(entry, kind, product);
        });

        return button;
    }

    /*
     * `kind` is a string for a grid holding one kind of thing, or a function of
     * the entry for the one grid that mixes them.
     */
    function renderGrid(grid, entries, kind, product) {
        entries.forEach(function (entry) {
            grid.appendChild(
                tile(entry, typeof kind === "function" ? kind(entry) : kind,
                     product));
        });
    }

    /* ---- detail popover --------------------------------------------------- */

    /*
     * `className` lands on both halves of the row, and exists for the one row
     * whose value is a control rather than a line of text: a button is taller
     * than the line it replaces, and its label has to be centred against it
     * instead of sitting at the top of the row like the others.
     */
    function fact(facts, label, value, className) {
        if (value == null || value === "" || (Array.isArray(value) && !value.length)) {
            return;
        }
        facts.appendChild(el("dt", className, label));
        var dd = el("dd", className);
        if (value instanceof Node) {
            dd.appendChild(value);
        } else if (Array.isArray(value)) {
            dd.textContent = value.join(", ");
        } else {
            dd.textContent = String(value);
        }
        facts.appendChild(dd);
    }

    /*
     * The hex, with a chip of the colour standing next to it, and the pair of
     * them a button that copies the value.
     *
     * A hex is there to be pasted somewhere else — it is the one thing on this
     * page with an obvious destination — so the value itself is the control
     * rather than a copy icon sitting next to it. The chip comes along because
     * the two read as one object; pressing the colour to take the colour is the
     * whole gesture.
     */
    function colorValue(hex) {
        var button = el("button", "copy");
        button.type = "button";
        button.setAttribute("aria-label", "Copy " + hex);

        var chip = el("span", "detail-chip");
        chip.style.backgroundColor = hex;
        button.appendChild(chip);
        button.appendChild(el("span", null, hex));

        return copyOnClick(button, function () { return hex; }, "Hex value");
    }

    /*
     * The colourway a print was run in, where the record says what it was.
     *
     * lt.json has one for all ten colour numbers, but only three of them —
     * 023 Cream/Black, 231 Tan/Black, 232 Cream/Brown — were ever named in
     * Field's Fabrics' catalogues. The other seven are named off the
     * photographs, and the panel shows nothing for them: not the name, which
     * would be a word standing where a record should be, and so not the hexes
     * either, which without it are a set of colours with nothing to call them.
     * They stay in the file, marked name_source: estimated, for anyone reading
     * the data.
     */
    function documented(entry) {
        var way = entry.colorway;
        return way && way.name_source === "fields_catalog" ? way : null;
    }

    /*
     * A print's colours, one copyable hex per ink, lightest first — which for
     * every one of these prints is the ground and then what was printed on it.
     *
     * No name against any of them: for three of the ten colourways the names
     * are on the line under the code already, and for the other seven there is
     * no name to give.
     */
    function inkValue(way) {
        var list = el("ul", "detail-inks");
        way.colors.forEach(function (ink) {
            var item = el("li");
            item.appendChild(colorValue(ink.hex));
            list.appendChild(item);
        });
        return list;
    }

    /*
     * The short list. lt.json carries a great deal more per entry — listing
     * dates, colour-card appearances, sample-order windows, the Field's
     * exclusivity evidence, an older sampling of the same colour — and all of
     * it stays in the file for anyone reading the data directly. The panel
     * shows only what tells you about the colour in front of you: what it is,
     * what it was called or numbered before, and the capture it came from. The
     * rest was provenance for the dataset, not for the swatch.
     */
    function facts_for(entry, kind, product) {
        var facts = el("dl", "detail-facts");

        /*
         * The identifier — SKU, or pattern/colour number — is already the
         * subtitle under the name, so it is not repeated as a row here.
         */
        if (kind === "pattern") {
            /*
             * A print is not one colour, so it gets the inks it was run in
             * rather than a hex — and it gets them from its colour number,
             * which is what that number is: 023 is Cream/Black on all six
             * prints that carry it, not a serial for any one of them.
             *
             * Only where the record says what the combination was, though.
             * The hexes for the other seven are as good a measurement, but
             * they would be a set of colours with nothing to call them and no
             * source behind them, which is not what this panel is for — see
             * documented().
             */
            var way = documented(entry);
            if (way) {
                fact(facts, "Estimated color", inkValue(way), "fact-inks");
            }
        } else if (entry.hex) {
            /*
             * "Estimated" rather than "sampled": the number is a median taken
             * off a small archived JPEG, not a reading off the cloth.
             */
            fact(facts, "Estimated color", colorValue(entry.hex));
        }

        /*
         * Directly under the hex, because the two are the same fact at two
         * resolutions: the colour as one number, and the colour as the whole
         * recipe that number was pulled out of.
         */
        fact(facts, "Shader", shaderValue(entry, product), "fact-control");

        /*
         * Where the picture above is not a picture of this cloth. A handful of
         * the pre-2011 colours were never photographed in Light, but Field's
         * sold the same colour in ST under its own number and photographed
         * that: the colour is the colour, the nap is not the same cloth, and
         * the reader is told before they take the swatch for a Light one.
         *
         * This used to be a note hanging off the Source row, and it outlived
         * it — the row is gone and the substitution still has to be declared.
         * It carries the paired number as well as the weight, because the pair
         * is the claim; `based_on.evidence` in lt.json names the catalogue
         * sheet that prints the two together, for anyone checking it.
         */
        if (entry.based_on) {
            fact(facts, "Based on",
                 entry.based_on.weight + " #" + entry.based_on.code);
        }

        if (kind === "color" && entry.former_skus && entry.former_skus.length) {
            fact(facts, "Former SKUs", entry.former_skus.map(function (s) {
                return typeof s === "string" ? s : (s.sku || s.name || JSON.stringify(s));
            }));
        }

        if (kind === "historical") { fact(facts, "Sold as", entry.widths); }

        /*
         * The other ways Field's printed the name, which is worth showing
         * because some of them are Field's own typos — "Eclispe", "Bourdeax" —
         * and a reader searching for the colour may well have it spelled that
         * way rather than this one.
         *
         * It is a fact about the paper record, though, and so it is shown
         * where the paper record is what the reader is being given: the
         * missing-image section, where a list of sightings is the whole of the
         * evidence. A colour off those same pre-2011 lists whose archived scan
         * later turned up is a custom colour now, and it is shown as one — the
         * same rows as every other custom colour, and no footnotes from the
         * grid it used to sit in.
         */
        if (kind !== "custom" && entry.name_variants) {
            fact(facts, "Also printed as", entry.name_variants.filter(
                function (name) { return name !== entry.name; }));
        }

        if (entry.see_also) {
            fact(facts, "See also",
                 "#" + entry.see_also.code + " — " + entry.see_also.note);
        }

        if (kind === "custom" && entry.former_names && entry.former_names.length) {
            fact(facts, "Former names", entry.former_names.map(function (n) {
                return n.name;
            }));
        }

        /*
         * Labelled "Source" rather than "Archive" because of what it is for:
         * it is the capture that shows this colorway existed, and the reader
         * should be able to go and see it.
         */
        if (kind === "historical") {
            /*
             * Every capture rather than the latest one alone, and only here. A
             * colour with nothing to show is only as good as the number of
             * times the record says it existed, so the list of sightings is
             * the evidence itself — and it says which page or catalogue each
             * one came off. A colour that came back with a picture does not
             * need the argument made: it cites its latest capture as its
             * source, the same as every other swatch on the page.
             */
            var list = el("ul", "detail-captures");
            entry.captures.forEach(function (capture) {
                var item = el("li");
                item.appendChild(link(capture.archive_url, capture.date));
                item.appendChild(el("span", "capture-in", capture["in"]));
                list.appendChild(item);
            });
            fact(facts, "Seen in", list);
        }

        return facts;
    }

    /*
     * The shader, as a row of the facts under the hex.
     *
     * What is worth taking away from this page is the recipe as much as the
     * number: a colour here is a median, an axis and a contrast run through a
     * noise field, and the listing handed over has those three frozen into it
     * so it compiles and draws this swatch on its own, with no lt.json and none
     * of this page around it.
     *
     * It sits in the list rather than in a block of its own because it is the
     * same kind of statement as the rows around it — here is the hex, here is
     * the shader, here is the capture they came from — and a label and a value
     * is all any of them needs. The value names the language rather than the
     * gesture, for the same reason the hex row's value is the hex: what is
     * copied is the thing named.
     *
     * Built from the entry's nap block rather than from anything the renderer
     * did, so a browser with no WebGL — which shows the flat hex in the panel
     * beside this — still has the shader to give. An entry with no nap block,
     * which is every Light Jungle print, gets no row at all rather than a
     * button that copies nothing.
     */
    function shaderValue(entry, product) {
        var code = Nap.source(entry, {
            weave: product && product.weave,
            light: product && product.light,
            closeup: product && product.closeup,
            product: product && product.label
        });
        if (!code) { return null; }

        var button = el("button", "copy");
        button.type = "button";
        /*
         * The glyph stands where the hex row's chip stands, and says the same
         * thing about the row it is in — but the label beside it names what is
         * being taken, not what pressing does, so the accessible name says it.
         */
        button.setAttribute("aria-label", "Copy GLSL");
        button.appendChild(copyIcon());
        button.appendChild(el("span", null, "GLSL"));

        return copyOnClick(button, function () { return code; }, "GLSL");
    }

    /*
     * What the colour number in the code above it means, in words: the inks the
     * print was run in, lightest first. Field's Fabrics' name for the
     * combination, and only theirs — see documented().
     */
    function colorwayLine(way) {
        return el("p", "detail-colorway text-sm mb-2",
                  way.colors.map(function (ink) {
                      return ink.name;
                  }).join(" / "));
    }

    /*
     * The two-button switch under the popover's image. It is only built where
     * there is actually a choice to make — an entry with no photograph, or a
     * pattern with no shader, gets no switch rather than a dead half of one.
     */
    function mediaSwitch() {
        var group = el("div", "detail-switch");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", "Swatch rendering");

        var halves = [];

        function sync() {
            halves.forEach(function (half) {
                half[0].setAttribute("aria-pressed",
                    String(showPhoto === half[1]));
            });
        }

        [["Shader", false], ["Photo", true]].forEach(function (option) {
            var button = el("button", null, option[0]);
            button.type = "button";
            halves.push([button, option[1]]);
            button.addEventListener("click", function () {
                if (showPhoto === option[1]) { return; }
                showPhoto = option[1];
                showSide();
                sync();
            });
            group.appendChild(button);
        });

        sync();
        return group;
    }

    /*
     * Pull the popover's photograph into the cache while the reader is still
     * looking at the shader. The switch is two clicks from being wanted at the
     * most, and this is the difference between it appearing at once and it
     * arriving after a visible beat — the tile only ever loaded the small
     * image, so the large one is a cold fetch the first time.
     */
    /* The two renderings currently in the panel, so the switch can toggle them. */
    var sides = { canvas: null, photo: null };

    /*
     * Both sides are built once, when the panel opens, and the switch only
     * changes which one is hidden. Rebuilding the <img> on each switch is what
     * made the photograph flash: a fresh element has to be fetched, decoded and
     * laid out before it can paint, and none of that is free even when the
     * bytes are already cached. Built up front it is decoded and ready long
     * before anyone reaches the button, and switching costs one attribute.
     *
     * Building it up front is also the preload — a hidden <img> is still
     * fetched — so the photograph starts downloading the moment the swatch is
     * clicked rather than when the reader asks for it.
     */
    function buildMedia(entry, product) {
        clear(media);
        sides.canvas = null;
        sides.photo = null;

        var photo = photoOf(entry);

        /*
         * The render is attempted even when the photograph is the side being
         * shown. It costs a fraction of a millisecond, and it is the only
         * honest way to know whether the switch has two working sides — a
         * context loss would otherwise leave it offering a shader that cannot
         * draw, with "Shader" lit over a photograph.
         */
        var canvas = canRender(entry)
            ? napCanvas(entry, DETAIL_PX,
                entry.name + " — drawn from its sampled color", product)
            : null;

        if (canvas) {
            sides.canvas = canvas;
            media.appendChild(canvas);
        }

        if (photo) {
            sides.photo = photoImg(entry, photo, false);
            /*
             * Decoding off the main thread, so the first reveal is a paint and
             * nothing else. Deliberately not awaited and not gated on: it never
             * settles while the tab is in the background, and a photograph that
             * only appears once the window is focused would be a worse bug than
             * the one this is here to fix.
             */
            if (sides.photo.decode) {
                sides.photo.decode().catch(function () { return null; });
            }
            media.appendChild(sides.photo);
        }

        if (!canvas && !photo) {
            var block = el("div", "detail-swatch");
            block.style.backgroundColor = entry.hex || "var(--lisa-background-muted-color)";
            media.appendChild(block);
        }

        /* Only a panel with both sides has a switch, and so a square box. */
        var pair = Boolean(canvas && photo);
        media.classList.toggle("detail-media-pair", pair);
        if (pair) { media.appendChild(mediaSwitch()); }

        showSide();
    }

    /* Which of the built sides is visible. The photo stands in where there is
     * no shader to draw, which is every Light Jungle print. */
    function showSide() {
        var usePhoto = Boolean(sides.photo) && (showPhoto || !sides.canvas);
        if (sides.canvas) { sides.canvas.hidden = usePhoto; }
        if (sides.photo) { sides.photo.hidden = !usePhoto; }
    }

    function show(entry, kind, product) {
        clear(head);
        clear(body);
        /* Only meaningful where both sides exist; showSide() falls back to
         * whichever one the entry actually has. */
        showPhoto = false;

        /*
         * One panel serves every tile, so the box keeps whatever scroll the
         * last entry was left at. Read a long entry to the bottom, close it,
         * open a short one, and it opens part-read.
         */
        detail.scrollTop = 0;

        /*
         * With no hex, no photograph and no shader there is nothing to put in
         * the image column, so the panel drops it rather than standing an empty
         * box there and giving the text 60% of the width for no reason.
         */
        var empty = blank(entry);
        media.hidden = empty;
        if (!empty) { buildMedia(entry, product); } else { clear(media); }

        /*
         * The name and the number that qualifies it go in the head rather than
         * at the top of the body. On the wide panel that is the same place —
         * the head is the first row of the right-hand column and the rows are
         * flush — but it is a cell of the grid rather than a paragraph of the
         * body, which is what lets the phone layout lift the pair above the
         * image without the facts coming with them.
         */
        head.appendChild(el("h2", "detail-title text-xl", entry.name));

        var way = documented(entry);
        var sub = codeOf(entry, kind);
        if (sub) {
            head.appendChild(el("p", "detail-sub text-sm" + (way ? "" : " mb-2"),
                                sub));
        }
        if (way) { head.appendChild(colorwayLine(way)); }

        body.appendChild(facts_for(entry, kind, product));

        popover.showPopover();
    }

    /* ---- boot ------------------------------------------------------------- */

    /*
     * The products, in the order they appear on the page: LT first as the line
     * this archive was built around, then the rest.
     *
     * `label` heads the section and `navLabel` names it in the navbar, which is
     * a row of six across the top and has to stay one line — so the navbar keeps
     * only what tells one product from another ("LT", not "Ultrasuede LT";
     * "DS102", not "Texvision DS102") while the section heading, which has the
     * width to spare, carries the full name. Where the two are the same there
     * is no navLabel and the label serves both.
     *
     * `labels` overrides a subsection heading where a product has its own word
     * for it — LT's patterns are the Light Jungle prints and calling them that
     * is worth more than calling them "Patterns".
     */
    var PRODUCTS = [
        { id: "lt", file: "lt.json", label: "Ultrasuede LT", navLabel: "LT",
          labels: { patterns: "Jungle prints" } },
        /*
         * 800px frames from Toray's storefront, and 418px Toray swatches: the
         * two best sets of photographs here, and still behind the switch. The
         * tiles draw the shader like everything else so the page compares.
         *
         * They are also the hardest-lit pictures in the library, by a factor of
         * three on a curve the other four products agree on, so LX is the one
         * product that keeps only part of its measured contrast. See `flatten`
         * in nap.js for what that factor is and how it was arrived at.
         */
        { id: "lx", file: "lx.json", label: "Ultrasuede LX", navLabel: "LX",
          light: 0.3 },
        { id: "st", file: "st.json", label: "Ultrasuede ST", navLabel: "ST" },
        /*
         * Its photographs are the only close-ups in the library — about 2.6x
         * more magnified than the archive's swatch shots, measured two ways
         * that agree — so its frames resolve nap the others average away and
         * its contrast is read high by a constant factor. See `closeup` in
         * nap.js. The spectrum underneath is Ultrasuede's, so the weave is.
         */
        { id: "lamous-th", file: "lamous-th.json", label: "Lamous TH",
          navLabel: "Lamous", closeup: 0.72 },
        /*
         * The one fabric here that is not Ultrasuede or a copy of it, and the
         * one whose texture is known from a picture big enough to measure: its
         * nap is a dense even grain rather than a cloud, so it is drawn with
         * the shader fitted to that. See WEAVES in nap.js.
         */
        { id: "shammy", file: "shammy.json", label: "Shammy 707J",
          navLabel: "Shammy", weave: "grain" },
        { id: "ds102", file: "texvision-ds102.json", label: "Texvision DS102",
          navLabel: "DS102" }
    ];

    /*
     * Subsections, in page order. `pick` pulls the entries for one out of a
     * product file, so a product that has no patterns and no historical colours
     * simply yields nothing for those and they are left off its section rather
     * than standing empty.
     */
    var SUBSECTIONS = [
        {
            key: "colors", label: "Official colors", unit: "colors",
            kind: "color",
            pick: function (d) { return d.colors || []; }
        },
        {
            key: "patterns", label: "Patterns", unit: "patterns",
            kind: "pattern",
            /* a pattern with nothing to show belongs in "missing", not here */
            pick: function (d) {
                return (d.patterns || []).filter(function (p) { return !blank(p); });
            }
        },
        {
            key: "custom", label: "Custom colors", unit: "colors",
            kind: "custom",
            pick: function (d) { return d.custom_colors || []; }
        },
        {
            /*
             * What the record names but cannot show. Built to mix — a pattern
             * with no capture belongs here as much as a colour does, sorted in
             * by name, because a reader looking for a name should not have to
             * know which of the two it is.
             */
            key: "missing", label: "Missing image", unit: "colors",
            /* mb-4 like every other grid: without it this one sat flush against
             * whatever followed, which on ST was the next product's heading. */
            grid: "record-grid grid grid-cols-4 gap-1 mb-4",
            kind: function (entry) {
                return entry.pattern ? "pattern" : "historical";
            },
            pick: function (d) {
                return (d.historical_colors || [])
                    .concat((d.patterns || []).filter(blank))
                    .sort(function (a, b) { return a.name.localeCompare(b.name); });
            }
        }
    ];

    var GRID_DEFAULT = "swatch-grid grid grid-cols-6 gap-1 mb-4";

    function headRow(cls, tag, headClass, text) {
        var row = el("div", cls +
            " flex flex-row items-baseline justify-between flex-wrap gap-2 mb-2");
        row.appendChild(el(tag, headClass, text));
        var count = el("p", "section-label text-sm");
        row.appendChild(count);
        return { row: row, count: count };
    }

    /* Build one product's section. Returns null if it has nothing to draw. */
    function renderProduct(data, cfg) {
        var section = el("section");
        section.id = cfg.id;

        /*
         * The product's name and nothing else. The count that used to sit
         * against it said how much the whole section held, which is a number
         * nobody reads down — each subsection already prints its own beside the
         * grid it counts, and that is the one that answers a question.
         */
        var head = el("div", "section-head mb-3");
        head.appendChild(el("h2", "text-2xl", cfg.label));
        section.appendChild(head);

        var total = 0;
        SUBSECTIONS.forEach(function (sub) {
            /*
             * An entry marked on_page: false stays in the file and is left off
             * the page — the file is the record and nothing is dropped from it
             * to change what is drawn. Each one says why in off_page_reason.
             */
            var entries = sub.pick(data).filter(onPage);
            if (!entries.length) { return; }

            var hr = headRow("subsection-head-row", "h3",
                             "subsection-head text-lg",
                             (cfg.labels && cfg.labels[sub.key]) || sub.label);
            hr.count.textContent = entries.length + " " + sub.unit;
            section.appendChild(hr.row);

            var grid = el("div", sub.grid || GRID_DEFAULT);
            section.appendChild(grid);
            renderGrid(grid, entries, sub.kind, cfg);

            total += entries.length;
        });

        if (!total) { return null; }

        return section;
    }

    var main = document.querySelector("main");
    var nav = document.getElementById("product-nav");

    /*
     * Fetched together but rendered in the configured order, and one product
     * failing does not take the others down with it — a missing file costs its
     * own section and a line saying so, not the page.
     */
    Promise.all(PRODUCTS.map(function (cfg) {
        return fetch(cfg.file)
            .then(function (response) {
                if (!response.ok) {
                    throw new Error(cfg.file + ": HTTP " + response.status);
                }
                return response.json();
            })
            .then(function (data) { return { cfg: cfg, data: data }; })
            .catch(function (error) { return { cfg: cfg, error: error }; });
    })).then(function (results) {
        var drawn = 0;
        results.forEach(function (result) {
            if (result.error) {
                main.appendChild(el("p", "text-sm",
                    "Could not load " + result.error.message + "."));
                return;
            }
            var section = renderProduct(result.data, result.cfg);
            if (!section) { return; }
            main.appendChild(section);

            var li = el("li");
            var a = el("a", null, result.cfg.navLabel || result.cfg.label);
            a.href = "#" + result.cfg.id;   /* same page: not link(), which opens a tab */
            li.appendChild(a);
            nav.appendChild(li);
            drawn += 1;
        });
        if (!drawn) {
            main.appendChild(el("p", "text-sm",
                "Nothing loaded. Serve this page over HTTP rather than opening " +
                "the file directly."));
            return;
        }
        /* Every tile now has a position, so it can be asked whether it is near
         * enough to be worth drawing. */
        drawTiles();
    });
}());
