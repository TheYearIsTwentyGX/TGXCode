// Find and replace in the live composer: the bar above the box, the marks
// behind its text, and the edits.
//
// The matching is composer/find-match.js, which has no DOM and is what the test
// pins. This file is the part that needs a browser.
//
// **Not Ctrl+F.** The composer has the focus most of the day — opening a session
// puts the caret there — so "Ctrl+F in the composer finds in the composer" would
// in practice mean Ctrl+F stopped finding in the conversation, which is the one
// people reach for. So Ctrl+F is left alone, Ctrl+H opens this with Replace (as
// it does in VS Code), and `composer.find` is a separate binding (Ctrl+Alt+F) for
// the bar without it. Both are in bridge/keymap.js and remappable. Once the bar
// has the focus, F3 and Shift+F3 step through *its* matches, and Ctrl+F there
// goes back to its own field rather than opening the other find.
//
// **The marks are a mirror behind the box.** A textarea cannot style a range of
// its own text, and the Custom Highlight API the conversation's find paints with
// does not reach inside one. So `#input-marks` is a div laid exactly under the
// textarea — the same font, padding, width and wrap, the textarea's background
// being transparent already — holding the same text in transparent ink with each
// match wrapped in a <mark>. Behind rather than over, so the caret and the
// selection still draw on top and typing inside a match looks like typing.
// Kept aligned by three things: the box's `input` (the text), its `scroll` (the
// offset), and a ResizeObserver (auto-grow, the window's width, zoom). Writes to
// `.value` from code fire none of those, which is why autoGrow() calls
// syncComposerFind() — every one of them is followed by autoGrow.
//
// **Every edit is one undo step.** Replace and Replace all both go through
// insertAt() in mentions.js, which splices with `execCommand('insertText')` —
// the browser's own edit, so Ctrl+Z takes it back and the `input` event it fires
// runs the draft save, the slash and mention parsers and the auto-grow exactly as
// typing would. Replace all is one splice from the first match to the last, so
// it is one step too, however many matches it covered.
//
// Imports siblings that import app.js; safe for the reason every composer module
// gives — nothing here reads an import while the module evaluates.

import { dom } from '../dom.js';
import { state } from '../state.js';
import * as keys from '../keys.js';
import { present } from '../motion.js';
import { caretLine, revealTop } from './caret.js';
import { insertAt } from './mentions.js';
import { live } from './slash.js';
import {
    compile, countLabel, expand, findMatches, matchFrom, replaceAll,
} from './find-match.js';

const F = {
    open: false,
    regex: false,
    matchCase: false,
    wholeWord: false,
    re: null,
    error: '',
    matches: [],
    capped: false,
    at: -1,
    // The text the matches were found in. A value written from code fires no
    // event, so a mismatch here is how a stale list is noticed.
    text: '',
    // Where "current" is counted from while the query is being typed: the caret
    // when the bar opened, so the first hit is the one after where you were.
    anchor: 0,
};

const box = () => live.input;

/** Is the bar, or the box it searches, where the keys are going? */
export const composerFindHasFocus = () => F.open
    && (dom.cfind.contains(document.activeElement) || document.activeElement === box());

export const composerFindOpen = () => F.open;

// ── opening and closing ──────────────────────────────────────────────────

/**
 * Show the bar. With a single-line selection in the box, that is the query —
 * the same as every editor, and the quick way to ask "where else did I say
 * this". A selection across lines is left alone: it is almost never what you
 * meant to search for, and it would not fit in the field.
 */
export function openComposerFind({ replace = false } = {}) {
    const ta = box();
    if (!state.current || ta.disabled) return;
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel && !sel.includes('\n')) {
        dom.cfindInput.value = F.regex ? sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : sel;
    }
    F.anchor = ta.selectionStart;
    // From closed, the chord decides whether Replace shows; once the bar is up,
    // Ctrl+H adds it and Ctrl+Alt+F leaves it as it is.
    if (replace || !F.open) showReplace(replace);
    if (!F.open) {
        F.open = true;
        present(dom.cfind, true, { as: 'drop' });
        ensureObserver();
    }
    refresh();
    const field = replace && dom.cfindInput.value ? dom.cfindReplace : dom.cfindInput;
    field.focus();
    field.select();
}

/**
 * Put the bar away, and with `focus`, hand the box back with the current match
 * selected — so Esc leaves you where find had taken you rather than where you
 * were before you opened it.
 */
export function closeComposerFind({ focus = false } = {}) {
    if (!F.open) return;
    const m = F.matches[F.at];
    F.open = false;
    F.matches = [];
    F.at = -1;
    present(dom.cfind, false, { as: 'drop' });
    paintMarks();
    const ta = box();
    if (focus && !ta.disabled) {
        ta.focus();
        if (m && m.end <= ta.value.length) ta.setSelectionRange(m.start, m.end);
    }
}

function showReplace(on) {
    dom.cfindReplaceRow.hidden = !on;
    dom.cfindToggle.setAttribute('aria-expanded', String(on));
    dom.cfindToggle.classList.toggle('on', on);
}

// ── finding ──────────────────────────────────────────────────────────────

/**
 * Find again from scratch. `anchor` is where "current" is counted from; the
 * default keeps the one that was current, by position, which is what an edit
 * somewhere else in the box should do.
 */
function refresh({ anchor } = {}) {
    if (!F.open) return;
    const ta = box();
    const query = dom.cfindInput.value;
    const keep = F.matches[F.at];
    const c = compile(query, { regex: F.regex, matchCase: F.matchCase });
    F.text = ta.value;
    F.re = c && c.re ? c.re : null;
    F.error = c && c.error ? c.error : '';
    const found = F.re ? findMatches(F.text, F.re, { wholeWord: F.wholeWord })
        : { matches: [], capped: false };
    F.matches = found.matches;
    F.capped = found.capped;
    const from = anchor ?? (keep ? keep.start : F.anchor);
    F.at = matchFrom(F.matches, from);
    paint();
}

/** The box changed under the bar. Called from autoGrow and the box's `input`. */
export function syncComposerFind() {
    if (!F.open || box().value === F.text) return;
    F.anchor = box().selectionStart;
    refresh({ anchor: F.anchor });
}

function step(dir) {
    if (!F.open) return;
    if (box().value !== F.text) refresh();
    const n = F.matches.length;
    if (!n) return;
    F.at = F.at < 0 ? (dir > 0 ? 0 : n - 1) : (F.at + dir + n) % n;
    paint({ reveal: true });
}

// ── replacing ────────────────────────────────────────────────────────────

/**
 * Replace the current match and move to the next.
 *
 * A replacement that leaves the text as it was — `x` for `x`, or nothing for a
 * zero-length match — steps on instead, or the button would stand still on the
 * same match forever.
 */
function replaceOne() {
    if (box().value !== F.text) refresh();
    const m = F.matches[F.at];
    if (!m) return;
    const text = F.text;
    const next = expand(dom.cfindReplace.value, text, m, F.regex);
    if (next === text.slice(m.start, m.end)) { step(1); return; }
    const back = document.activeElement;
    insertAt(live, m.start, m.end, next);
    // insertAt's `input` has already run syncComposerFind, from the caret, which
    // insertAt leaves after the replacement: so the current match is now the
    // next one. Painted again to bring it into view.
    paint({ reveal: true });
    if (back && dom.cfind.contains(back)) back.focus();
}

function replaceEvery() {
    if (box().value !== F.text) refresh();
    if (!F.re) return;
    const text = F.text;
    // Uncapped. The cap is for drawing ten thousand marks on every keystroke;
    // Replace all is one pass and one splice, and stopping at the cap would leave
    // a long paste half-replaced with nothing on screen to say so.
    const { matches } = findMatches(text, F.re, { wholeWord: F.wholeWord, cap: Infinity });
    const r = replaceAll(text, matches, dom.cfindReplace.value, F.regex);
    if (!r) return;
    const back = document.activeElement;
    if (r.text !== text) insertAt(live, r.from, r.to, r.insert);
    if (back && dom.cfind.contains(back)) back.focus();
    // Said in the counter, which is a live region, until the next change.
    dom.cfindCount.textContent = `Replaced ${r.count}`;
}

// ── painting ─────────────────────────────────────────────────────────────

function paint({ reveal = false } = {}) {
    const query = dom.cfindInput.value;
    dom.cfindCount.textContent = countLabel({
        query, error: F.error, matches: F.matches, capped: F.capped, at: F.at,
    });
    dom.cfindCount.title = F.error || '';
    dom.cfindInput.setAttribute('aria-invalid', String(Boolean(F.error)));
    const none = !F.matches.length;
    dom.cfindPrev.disabled = none;
    dom.cfindNext.disabled = none;
    dom.cfindOne.disabled = none;
    dom.cfindAll.disabled = none;
    for (const [node, on] of [[dom.cfindRegex, F.regex], [dom.cfindCase, F.matchCase],
        [dom.cfindWord, F.wholeWord]]) {
        node.setAttribute('aria-pressed', String(on));
    }
    const m = F.matches[F.at];
    const ta = box();
    if (reveal && m) {
        // The selection too, so Esc — or a click back into the box — starts from
        // the match. Setting it does not move the focus out of the bar.
        ta.setSelectionRange(m.start, m.end);
        revealMatch(ta, m);
    }
    paintMarks();
}

/** Scroll the box, not the page, so the match is in view. */
function revealMatch(ta, m) {
    if (ta.scrollHeight <= ta.clientHeight) return;
    // The padding on both sides, so the current match's ring is not cut by the
    // edge of the box.
    const cs = getComputedStyle(ta);
    const top = caretLine(ta, m.start).top - (parseFloat(cs.paddingTop) || 0);
    const bottom = caretLine(ta, m.end).bottom + (parseFloat(cs.paddingBottom) || 0);
    ta.scrollTop = revealTop({
        top, bottom, scrollTop: ta.scrollTop, height: ta.clientHeight,
        max: ta.scrollHeight - ta.clientHeight,
    });
}

// What has to match for the mirror to wrap where the box does. caret.js has
// its own list for its own off-screen mirror; this one also carries the
// borders, because it sits in the box's place rather than off to one side.
const MIRRORED = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
    'fontFeatureSettings', 'fontKerning', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'textTransform', 'textIndent', 'textRendering', 'tabSize', 'wordBreak', 'direction',
    'paddingTop', 'paddingLeft', 'paddingBottom',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
];

function placeMarks() {
    const ta = box();
    const mk = dom.inputMarks;
    const cs = getComputedStyle(ta);
    for (const k of MIRRORED) mk.style[k] = cs[k];
    // The box's scrollbar narrows the width its text wraps in, and the mirror has
    // none — so the gap goes on as padding.
    const bars = ta.offsetWidth - ta.clientWidth
        - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
    mk.style.paddingRight = `${parseFloat(cs.paddingRight) + bars}px`;
    // From the rects rather than offsetLeft and friends, which round: the box is
    // a flex item and is rarely a whole number of pixels wide, and a mirror a
    // third of a pixel wider wraps a borderline word one line later.
    const a = ta.getBoundingClientRect();
    const row = mk.offsetParent || ta.parentElement;
    const r = row.getBoundingClientRect();
    mk.style.left = `${a.left - r.left - row.clientLeft}px`;
    mk.style.top = `${a.top - r.top - row.clientTop}px`;
    mk.style.width = `${a.width}px`;
    mk.style.height = `${a.height}px`;
    mk.scrollTop = ta.scrollTop;
}

function paintMarks() {
    const mk = dom.inputMarks;
    if (!F.open || !F.matches.length) {
        if (!mk.hidden) { mk.hidden = true; mk.textContent = ''; }
        return;
    }
    const text = F.text;
    const frag = document.createDocumentFragment();
    let at = 0;
    F.matches.forEach((m, i) => {
        if (m.start > at) frag.append(text.slice(at, m.start));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(m.start, m.end);
        if (m.start === m.end) mark.className = 'zero';
        if (i === F.at) mark.classList.add('at');
        frag.append(mark);
        at = m.end;
    });
    // The zero-width space keeps a trailing newline's empty line, which a
    // textarea draws and a div would not, so the two scroll the same distance.
    frag.append(`${text.slice(at)}​`);
    mk.replaceChildren(frag);
    mk.hidden = false;
    placeMarks();
}

let observer = null;
function ensureObserver() {
    if (observer || typeof ResizeObserver !== 'function') return;
    observer = new ResizeObserver(() => { if (F.open && !dom.inputMarks.hidden) placeMarks(); });
    observer.observe(box());
}

// ── wiring ───────────────────────────────────────────────────────────────

function toggle(which) {
    F[which] = !F[which];
    refresh();
}

export function wireComposerFind() {
    const ta = box();
    ta.addEventListener('input', syncComposerFind);
    ta.addEventListener('scroll', () => {
        if (F.open && !dom.inputMarks.hidden) dom.inputMarks.scrollTop = ta.scrollTop;
    });

    dom.cfindInput.addEventListener('input', () => refresh({ anchor: F.anchor }));
    dom.cfindPrev.addEventListener('click', () => step(-1));
    dom.cfindNext.addEventListener('click', () => step(1));
    dom.cfindOne.addEventListener('click', replaceOne);
    dom.cfindAll.addEventListener('click', replaceEvery);
    dom.cfindClose.addEventListener('click', () => closeComposerFind({ focus: true }));
    dom.cfindRegex.addEventListener('click', () => toggle('regex'));
    dom.cfindCase.addEventListener('click', () => toggle('matchCase'));
    dom.cfindWord.addEventListener('click', () => toggle('wholeWord'));
    dom.cfindToggle.addEventListener('click', () => {
        const on = dom.cfindReplaceRow.hidden;
        showReplace(on);
        (on ? dom.cfindReplace : dom.cfindInput).focus();
    });

    // The bar's own keys. Handled here and stopped, so the window's ladder —
    // whose Escape would close the conversation's find, or a panel behind —
    // never sees them.
    dom.cfind.addEventListener('keydown', (e) => {
        const inFind = e.target === dom.cfindInput;
        const inReplace = e.target === dom.cfindReplace;
        let done = true;
        if (e.key === 'Escape') closeComposerFind({ focus: true });
        else if (e.key === 'Enter' && inFind && !e.ctrlKey && !e.altKey) step(e.shiftKey ? -1 : 1);
        else if (e.key === 'Enter' && inReplace && (e.ctrlKey || e.metaKey) && e.altKey) replaceEvery();
        else if (e.key === 'Enter' && inReplace && !e.ctrlKey && !e.altKey) replaceOne();
        // VS Code's chords for the three toggles, which is where the letters on
        // their tooltips come from.
        else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyC') toggle('matchCase');
        else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyW') toggle('wholeWord');
        else if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyR') toggle('regex');
        else {
            const cmd = keys.match(e);
            if (cmd === 'find.next' || cmd === 'find.prev') step(cmd === 'find.prev' ? -1 : 1);
            // Inside this bar, the find chords mean this find.
            else if (cmd === 'find.open' || cmd === 'composer.find') { dom.cfindInput.focus(); dom.cfindInput.select(); }
            else if (cmd === 'composer.replace') { showReplace(true); dom.cfindReplace.focus(); dom.cfindReplace.select(); }
            else done = false;
        }
        if (!done) return;
        e.preventDefault();
        e.stopPropagation();
    });
}

/** F3 and Shift+F3 from the box itself, while the bar is up. */
export const stepComposerFind = step;
