// The element picker behind the preview toolbar's crosshair button.
//
// Taken whole from DevBrowser (~/Other/dev-browser/renderer.js,
// devBrowserPickerSource), which is the same author's and has shipped it for a
// while. Keep it a copy rather than a rewrite: the heuristics in here — which
// ids and classes look hashed, which jsx-source attributes carry a file and
// line — were earned one framework at a time, and the next fix should be a
// diff against DevBrowser's version, not a rediscovery.
//
// Everything inside the function runs in the *guest* page, not here: it is
// serialised with toString() and handed to <webview>.executeJavaScript, which is
// why it closes over nothing from this file and speaks only in globals. The
// `__devBrowser*` names are left as they were so a page opened in both browsers
// retires one session when the other arms.
//
// There is no iframe equivalent. A cross-origin iframe cannot be scripted, so
// web/preview.js disables the button there instead.

export function devBrowserPickerSource() {
    var MARK = 'data-devbrowser-picker';
    var NL = String.fromCharCode(10);
    var MAX_DEPTH = 6;
    var ATTR_HINTS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label'];
    var TAG_EXTRAS = ['data-testid', 'name', 'type', 'href', 'role', 'aria-label', 'placeholder'];
    // Path/line attributes emitted by the various jsx-source babel and vite plugins
    var SOURCE_ATTRS = [
        ['data-inspector-relative-path', 'data-inspector-line'],
        ['data-v-inspector', null],
        ['data-insp-path', null],
        ['data-source-loc', null],
        ['data-source', null]
    ];

    // A session left armed by a previous injection still owns listeners and an
    // overlay, so retire it before installing a replacement.
    if (window.__devBrowserPickerCancel) {
        try { window.__devBrowserPickerCancel(); } catch (e) { /* already gone */ }
    }

    function isMarked(node) {
        return !!(node && node.nodeType === 1 && node.hasAttribute && node.hasAttribute(MARK));
    }

    function esc(value) {
        return (window.CSS && CSS.escape) ? CSS.escape(value) : value;
    }

    function clip(text, limit) {
        return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
    }

    // Classes and ids carrying a build hash change on every rebuild, so a selector
    // built from them is worthless to whoever reads it next.
    function looksHashed(token, minLength) {
        return !!token && token.length >= minLength && /[0-9]/.test(token) && /[a-z]/i.test(token);
    }

    function isStableClass(name) {
        if (!name || name.length > 40) return false;
        if (/^(sc-|css-|jsx-|svelte-|emotion-)/.test(name)) return false;
        return !looksHashed(name.split(/[_-]/).pop(), 5);
    }

    function isStableId(id) {
        if (!id || id.length > 50) return false;
        if (id.charAt(0) === ':') return false;                     // React useId, e.g. ":r3:"
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return false;    // uuid
        return !looksHashed(id.split(/[_-]/).pop(), 6);
    }

    function stableClasses(node) {
        var out = [];
        var list = node.classList ? Array.prototype.slice.call(node.classList) : [];
        for (var i = 0; i < list.length && out.length < 2; i++) {
            if (isStableClass(list[i])) out.push(list[i]);
        }
        return out;
    }

    function isUnique(selector) {
        try {
            return document.querySelectorAll(selector).length === 1;
        } catch (e) {
            return false;
        }
    }

    function idSelector(node) {
        if (!node.id || !isStableId(node.id)) return null;
        var selector = '#' + esc(node.id);
        return isUnique(selector) ? selector : null;
    }

    function attrSelector(node) {
        for (var i = 0; i < ATTR_HINTS.length; i++) {
            var attr = ATTR_HINTS[i];
            var value = node.getAttribute ? node.getAttribute(attr) : null;
            if (!value || value.length > 60 || value.indexOf('"') !== -1) continue;
            var selector = node.tagName.toLowerCase() + '[' + attr + '="' + value + '"]';
            if (isUnique(selector)) return selector;
        }
        return null;
    }

    function countMatching(nodes, selector) {
        var hits = 0;
        for (var i = 0; i < nodes.length; i++) {
            try {
                if (nodes[i].matches(selector)) hits++;
            } catch (e) { /* selector the browser will not parse */ }
        }
        return hits;
    }

    // Guaranteed-unique but unreadable; only used when the readable path is ambiguous.
    function structuralPath(el) {
        var parts = [];
        var node = el;
        while (node && node.parentElement) {
            var index = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
            parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + index + ')');
            node = node.parentElement;
        }
        parts.unshift(node ? node.tagName.toLowerCase() : 'html');
        return parts.join(' > ');
    }

    function selectorFor(el) {
        var direct = idSelector(el) || attrSelector(el);
        if (direct) return direct;

        var parts = [];
        var node = el;

        while (node && node.nodeType === 1 && parts.length < MAX_DEPTH) {
            var anchor = idSelector(node);
            if (anchor) {
                parts.unshift(anchor);
                break;
            }

            var part = node.tagName.toLowerCase();
            var classes = stableClasses(node);
            for (var c = 0; c < classes.length; c++) part += '.' + esc(classes[c]);

            var parent = node.parentElement;
            if (parent) {
                var twins = [];
                for (var t = 0; t < parent.children.length; t++) {
                    if (parent.children[t].tagName === node.tagName) twins.push(parent.children[t]);
                }
                // Only pay for :nth-of-type when tag plus classes cannot tell the twins apart
                if (twins.length > 1 && countMatching(twins, part) > 1) {
                    part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')';
                }
            }

            parts.unshift(part);
            if (node === document.body) break;
            node = parent;
        }

        var selector = parts.join(' > ');
        return (selector && isUnique(selector)) ? selector : structuralPath(el);
    }

    function describeTag(el) {
        var out = '<' + el.tagName.toLowerCase();

        if (el.id) out += ' id="' + el.id + '"';

        var classAttr = el.getAttribute ? el.getAttribute('class') : null;
        if (classAttr) out += ' class="' + clip(classAttr.replace(/\s+/g, ' ').trim(), 80) + '"';

        for (var i = 0; i < TAG_EXTRAS.length && out.length < 200; i++) {
            var value = el.getAttribute ? el.getAttribute(TAG_EXTRAS[i]) : null;
            if (value) out += ' ' + TAG_EXTRAS[i] + '="' + clip(value, 40) + '"';
        }

        return out + '>';
    }

    function textOf(el) {
        var text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        return text ? clip(text, 80) : null;
    }

    function shortenPath(file) {
        if (!file) return null;
        var normalised = String(file).replace(/\\/g, '/');
        var markers = ['/src/', '/app/', '/components/', '/pages/', '/lib/'];
        for (var i = 0; i < markers.length; i++) {
            var at = normalised.lastIndexOf(markers[i]);
            if (at !== -1) return normalised.slice(at + 1);
        }
        return normalised;
    }

    function fiberOf(node) {
        var keys = Object.keys(node);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
                return node[keys[i]];
            }
        }
        return null;
    }

    function componentName(fiber) {
        var type = fiber.type || fiber.elementType;
        if (!type || typeof type === 'string') return null;             // host element: div, button, ...
        if (typeof type === 'function') return type.displayName || type.name || null;
        if (typeof type === 'object') {
            if (type.displayName) return type.displayName;
            if (type.render) return type.render.displayName || type.render.name || null;   // forwardRef
            if (type.type) return componentName({ type: type.type });                      // memo
        }
        return null;
    }

    // _debugSource gives file:line in React 18 and earlier dev builds. React 19
    // dropped it, so the owner chain is the fallback that still says something useful.
    function reactInfo(node) {
        var fiber = null;
        var probe = node;
        while (probe && !fiber) {
            fiber = fiberOf(probe);
            probe = probe.parentElement;
        }
        if (!fiber) return null;

        var names = [];
        var source = null;
        var walker = fiber;
        var guard = 0;

        while (walker && guard++ < 40) {
            if (!source && walker._debugSource && walker._debugSource.fileName) source = walker._debugSource;
            var name = componentName(walker);
            if (name && names.indexOf(name) === -1) names.push(name);
            walker = walker._debugOwner || walker.return;
        }

        return { source: source, names: names };
    }

    function vueInfo(node) {
        var probe = node;
        var guard = 0;

        while (probe && probe.nodeType === 1 && guard++ < 30) {
            var instance = probe.__vueParentComponent;      // Vue 3
            if (instance) {
                var names = [];
                var file = null;
                var walker = instance;
                var depth = 0;
                while (walker && depth++ < 10) {
                    var type = walker.type || {};
                    if (!file && type.__file) file = type.__file;
                    var name = type.name || type.__name;
                    if (name && names.indexOf(name) === -1) names.push(name);
                    walker = walker.parent;
                }
                return { file: file, names: names };
            }

            var legacy = probe.__vue__;                     // Vue 2
            if (legacy) {
                var options = legacy.$options || {};
                return { file: options.__file || null, names: options.name ? [options.name] : [] };
            }

            probe = probe.parentElement;
        }
        return null;
    }

    function attrSource(node) {
        var probe = node;
        var guard = 0;

        while (probe && probe.nodeType === 1 && guard++ < 20) {
            for (var i = 0; i < SOURCE_ATTRS.length; i++) {
                var value = probe.getAttribute ? probe.getAttribute(SOURCE_ATTRS[i][0]) : null;
                if (!value) continue;
                var lineAttr = SOURCE_ATTRS[i][1];
                var line = lineAttr && probe.getAttribute ? probe.getAttribute(lineAttr) : null;
                return line ? value + ':' + line : value;
            }
            probe = probe.parentElement;
        }
        return null;
    }

    function buildPayload(el) {
        var rect = el.getBoundingClientRect();
        var lines = [];

        lines.push('Element: ' + describeTag(el));
        lines.push('Selector: ' + selectorFor(el));

        var text = textOf(el);
        if (text) lines.push('Text: "' + text + '"');

        lines.push('Box: ' + Math.round(rect.width) + 'x' + Math.round(rect.height) +
            ' at (' + Math.round(rect.left + window.scrollX) + ', ' + Math.round(rect.top + window.scrollY) + ')');

        var react = reactInfo(el);
        var vue = react ? null : vueInfo(el);
        var source = null;
        var components = null;

        if (react) {
            if (react.source) source = shortenPath(react.source.fileName) + ':' + react.source.lineNumber;
            components = react.names;
        } else if (vue) {
            if (vue.file) source = shortenPath(vue.file);
            components = vue.names;
        }
        if (!source) source = attrSource(el);

        if (source) lines.push('Source: ' + source);
        if (components && components.length) {
            // Collected innermost-first; read it outside-in like a component path
            lines.push('Component: ' + components.slice(0, 3).reverse().join(' > '));
        }
        lines.push('Page: ' + location.href);

        return lines.join(NL);
    }

    function labelFor(el, rect) {
        var name = el.tagName.toLowerCase();
        if (el.id) name += '#' + el.id;
        var classes = stableClasses(el);
        for (var i = 0; i < classes.length; i++) name += '.' + classes[i];
        return clip(name, 60) + '  ' + Math.round(rect.width) + 'x' + Math.round(rect.height);
    }

    // Resolves with the payload string on click, or null if the pick was cancelled.
    window.__devBrowserPick = function () {
        return new Promise(function (resolve) {
            var POINTER_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick',
                'pointerdown', 'pointerup', 'contextmenu', 'touchstart', 'touchend'];
            var active = true;
            var current = null;

            var box = document.createElement('div');
            box.setAttribute(MARK, 'box');
            box.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;' +
                'z-index:2147483646;border:2px solid #06B6D4;background:rgba(6,182,212,0.12);box-sizing:border-box;';

            var label = document.createElement('div');
            label.setAttribute(MARK, 'label');
            label.style.cssText = 'position:fixed;top:0;left:0;display:none;pointer-events:none;' +
                'z-index:2147483647;background:#06B6D4;color:#052A33;font:600 11px/1.5 monospace;' +
                'padding:2px 6px;border-radius:3px;white-space:nowrap;max-width:70vw;overflow:hidden;';

            var cursor = document.createElement('style');
            cursor.setAttribute(MARK, 'cursor');
            cursor.textContent = '*{cursor:crosshair !important;}';

            document.documentElement.appendChild(box);
            document.documentElement.appendChild(label);
            document.documentElement.appendChild(cursor);

            function highlight(el) {
                current = el;
                var rect = el.getBoundingClientRect();
                box.style.top = rect.top + 'px';
                box.style.left = rect.left + 'px';
                box.style.width = rect.width + 'px';
                box.style.height = rect.height + 'px';

                label.textContent = labelFor(el, rect);
                label.style.display = 'block';
                label.style.top = (rect.top > 22 ? rect.top - 22 : Math.min(rect.bottom + 4, window.innerHeight - 22)) + 'px';
                label.style.left = Math.max(0, Math.min(rect.left, window.innerWidth - 140)) + 'px';
            }

            function teardown() {
                active = false;
                window.removeEventListener('mousemove', onMove, true);
                window.removeEventListener('scroll', onScroll, true);
                window.removeEventListener('keydown', onKeyDown, true);
                for (var i = 0; i < POINTER_EVENTS.length; i++) {
                    window.removeEventListener(POINTER_EVENTS[i], onPointer, true);
                }
                if (box.parentNode) box.parentNode.removeChild(box);
                if (label.parentNode) label.parentNode.removeChild(label);
                if (cursor.parentNode) cursor.parentNode.removeChild(cursor);
                if (window.__devBrowserPickerCancel === cancel) delete window.__devBrowserPickerCancel;
            }

            function finish(result) {
                if (!active) return;
                teardown();
                resolve(result);
            }

            function cancel() {
                finish(null);
            }

            function onMove(event) {
                var target = event.target;
                if (!target || target.nodeType !== 1 || isMarked(target) || target === current) return;
                highlight(target);
            }

            function onScroll() {
                if (current && current.isConnected) highlight(current);
            }

            function onKeyDown(event) {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopImmediatePropagation();
                finish(null);
            }

            // Swallowed in the capture phase on window, the earliest point in the
            // path, so the page's own handlers never see the pointer at all.
            function onPointer(event) {
                event.preventDefault();
                event.stopImmediatePropagation();

                if (event.type === 'contextmenu') {
                    finish(null);
                    return;
                }
                if (event.type !== 'click') return;

                var target = isMarked(event.target) ? current : event.target;
                if (!target || target.nodeType !== 1) {
                    finish(null);
                    return;
                }

                var payload = null;
                try {
                    payload = buildPayload(target);
                } catch (e) {
                    payload = null;
                }
                finish(payload);
            }

            window.__devBrowserPickerCancel = cancel;
            window.addEventListener('mousemove', onMove, true);
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('keydown', onKeyDown, true);
            for (var i = 0; i < POINTER_EVENTS.length; i++) {
                window.addEventListener(POINTER_EVENTS[i], onPointer, true);
            }
        });
    };
}

// executeJavaScript resolves with the promise the last statement returns, so
// one call covers the whole pick session.
export const PICKER_SOURCE = `(${devBrowserPickerSource.toString()})(); window.__devBrowserPick();`;
