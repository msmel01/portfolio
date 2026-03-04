import rough from 'roughjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnnotationConfig {
    type: 'highlight' | 'crossed-off' | 'circle' | 'underline' | 'box';
    padding?: number | number[];
    strokeWidth?: number;
    color?: string;
    multiline?: boolean;
    iterations?: number;
}

interface AnnotationDef {
    selector: string;
    order: number;
    config: AnnotationConfig;
    multiple?: boolean;
}

interface AnnotationItem {
    el: HTMLElement;
    config: AnnotationConfig;
    order: number;
    svg: SVGSVGElement | null;
}

// ---------------------------------------------------------------------------
// Annotation definitions (one source of truth)
// ---------------------------------------------------------------------------

const ANNOTATION_DEFS: AnnotationDef[] = [
    { selector: '.checkbox-square', order: 0, config: { type: 'crossed-off', padding: 5, strokeWidth: 1.5, color: '#5703EF', iterations: 1 } },
    { selector: '.personal-line-1', order: 1, config: { type: 'highlight', padding: 5, strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    { selector: '.personal-line-2', order: 2, config: { type: 'highlight', padding: 5, strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    { selector: '.personal-line-3', order: 3, config: { type: 'highlight', padding: 5, strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    { selector: '.personal-line-4', order: 4, config: { type: 'highlight', padding: [5, 5, 5, 5], strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    // { selector: '.now-link', order: 5, config: { type: 'circle', padding: [0, 2, 3, 8], color: '#5703EF', iterations: 1 } },
    { selector: '.skill-text', order: 6, config: { type: 'highlight', padding: 5, strokeWidth: 1.5, color: '#F5DF4D' }, multiple: true },
    { selector: '.project-link', order: 7, config: { type: 'underline', padding: [0, 2, 6, 2], strokeWidth: 1.8, color: '#5703EF', iterations: 1 } },
    // { selector: '.employer-annotate', order: 8, config: { type: 'circle', padding: [5, 15, 5, 15], color: '#5703EF', iterations: 1 }, multiple: true },
    { selector: '.employer-annotate', order: 9, config: { type: 'box', padding: [4, 8, 4, 8], strokeWidth: 1.8, color: '#5703EF' }, multiple: true }
];

const DRAW_DURATION_MS = 450;
const STAGGER_MS = 220;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let activeObserver: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
let resizeHandler: (() => void) | null = null;
let snapListeners: Array<{ el: HTMLElement; type: string; fn: EventListener }> = [];
let currentWidth = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePadding(p: number | number[] | undefined): [number, number, number, number] {
    if (p === undefined) return [5, 5, 5, 5];
    if (typeof p === 'number') return [p, p, p, p];
    if (p.length === 2) return [p[0], p[1], p[0], p[1]];
    if (p.length === 4) return p as [number, number, number, number];
    return [5, 5, 5, 5];
}

/** Inject animation keyframes once into <head>. */
function ensureStyles() {
    if (document.getElementById('rgh-annotation-styles')) return;
    const style = document.createElement('style');
    style.id = 'rgh-annotation-styles';
    style.textContent = `
        /* stroke-dashoffset draw animation for circle / crossed-off */
        @keyframes rgh-draw {
            to { stroke-dashoffset: 0; }
        }
        /* left-to-right reveal for highlight fill — scaleX is compositor-accelerated */
        @keyframes rgh-reveal {
            from { transform: scaleX(0); }
            to   { transform: scaleX(1); }
        }
    `;
    document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// SVG construction  (hidden until animated)
// ---------------------------------------------------------------------------

/**
 * Walk up the ancestor chain and accumulate the CSS Z-rotation (in degrees).
 * Handles both matrix(a,b,c,d,e,f) and matrix3d(...) — in both cases the
 * Z-rotation is atan2(b, a) at indices 0 and 1.
 */
function getAncestorRotationDeg(el: HTMLElement): number {
    let total = 0;
    let node: HTMLElement | null = el.parentElement;
    while (node && node !== document.body) {
        const t = window.getComputedStyle(node).transform;
        if (t && t !== 'none') {
            // match both matrix(...) and matrix3d(...)
            const m = t.match(/^matrix(?:3d)?\(([^)]+)\)/);
            if (m) {
                const vals = m[1].split(',').map(Number);
                total += Math.atan2(vals[1], vals[0]) * (180 / Math.PI);
            }
        }
        node = node.parentElement;
    }
    return total;
}

/**
 * Get the position of `el` in the local (pre-transform) coordinate system of `container`.
 * `offsetTop`/`offsetLeft` walk is correct for absolutely-positioned children inside
 * a transformed container — unlike getBoundingClientRect() which gives post-transform
 * viewport coordinates.
 */
function getLocalOffset(el: HTMLElement, container: HTMLElement): { top: number; left: number } {
    let top = 0, left = 0;
    let node: HTMLElement | null = el;
    while (node && node !== container) {
        top += node.offsetTop;
        left += node.offsetLeft;
        node = node.offsetParent as HTMLElement | null;
    }
    return { top, left };
}

/** Find the nearest ancestor with a CSS transition property set (below document.body). */
function findTransitioningAncestor(el: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = el.parentElement;
    while (node && node !== document.body) {
        const t = window.getComputedStyle(node).transition;
        if (t && t !== 'none' && !t.startsWith('all 0s')) return node;
        node = node.parentElement;
    }
    return null;
}

function buildSVG(el: HTMLElement, config: AnnotationConfig): SVGSVGElement | null {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const [padTop, padRight, padBottom, padLeft] = normalizePadding(config.padding);
    const svgW = rect.width + padLeft + padRight;
    const svgH = rect.height + padTop + padBottom;

    // Use document-space coords (position:absolute on body) — bakes in scrollY so
    // the SVG never needs to move on scroll.
    const cssTop = rect.top + window.scrollY - padTop;
    const cssLeft = rect.left + window.scrollX - padLeft;

    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgEl.setAttribute('width', String(svgW));
    svgEl.setAttribute('height', String(svgH));
    svgEl.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    svgEl.classList.add('rgh-annotation');

    const rotationDeg = getAncestorRotationDeg(el);
    const baseTransform = rotationDeg !== 0 ? `rotate(${rotationDeg}deg)` : '';

    svgEl.style.cssText = [
        'position:absolute',
        `top:${cssTop}px`,
        `left:${cssLeft}px`,
        `width:${svgW}px`,
        `height:${svgH}px`,
        'pointer-events:none',
        'overflow:visible',
        `z-index:${config.type === 'highlight' ? 2 : 3}`,
        ...(config.type === 'highlight' ? ['mix-blend-mode:multiply'] : []),
        'opacity:0',
        'transform-origin:center',
        ...(baseTransform ? [`transform:${baseTransform}`] : []),
    ].join(';');

    const seed = (Math.abs(Math.round(cssTop * cssLeft)) % 9999) + 1;
    const rc = rough.svg(svgEl);

    const baseOpts = {
        roughness: 1.8,
        strokeWidth: config.strokeWidth ?? 1.5,
        stroke: config.color ?? '#000',
        seed,
        disableMultiStroke: false,
    };

    if (config.type === 'highlight') {
        const baseColor = config.color ?? '#F5DF4D';
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.dataset.rghHighlight = '1';

        // Use getClientRects() so multiline spans get one rect per line
        const lineRects = Array.from(el.getClientRects());
        // Fall back to the single bounding rect if getClientRects is unavailable
        const rects = lineRects.length > 0 ? lineRects : [el.getBoundingClientRect()];

        rects.forEach((lineRect, i) => {
            const lx = (lineRect.left + window.scrollX) - cssLeft;
            const ly = (lineRect.top + window.scrollY) - cssTop;
            const lw = lineRect.width;
            const lh = lineRect.height;
            const lineSeed = (seed + i * 37) % 9999 || 1;

            const node = rc.rectangle(lx, ly, lw, lh, {
                ...baseOpts,
                seed: lineSeed,
                fill: baseColor,
                fillStyle: 'solid',
                stroke: 'none',
                strokeWidth: 0,
                roughness: 1,
                disableMultiStroke: true,
            });
            g.appendChild(node);
        });

        svgEl.appendChild(g);

    } else if (config.type === 'crossed-off') {
        const crossedOpts = { ...baseOpts, disableMultiStroke: true };
        // Shrink to 60% of the SVG, centered, so the X sits tightly over the text
        const scaleX = svgW * 0.2;
        const scaleY = svgH * 0.2;
        const line1 = rc.line(scaleX, scaleY, svgW - scaleX, svgH - scaleY, crossedOpts);
        const line2 = rc.line(svgW - scaleX, scaleY, scaleX, svgH - scaleY, crossedOpts);
        svgEl.appendChild(line1);
        svgEl.appendChild(line2);

    } else if (config.type === 'circle') {
        const node = rc.ellipse(
            svgW / 2, svgH / 2,
            svgW - 4, svgH - 4,
            { ...baseOpts, roughness: 2, disableMultiStroke: true }
        );
        svgEl.appendChild(node);

    } else if (config.type === 'underline') {
        const y = svgH - (normalizePadding(config.padding)[2] / 2);
        const line = rc.line(0, y, svgW, y, {
            ...baseOpts,
            roughness: 2.5,
            disableMultiStroke: true,
        });
        svgEl.appendChild(line);

    } else if (config.type === 'box') {
        const [padTop, padRight, padBottom, padLeft] = normalizePadding(config.padding);
        const margin = 2; // inset slightly so the stroke isn't clipped by the SVG edge
        const rect = rc.rectangle(
            margin, margin,
            svgW - margin * 2, svgH - margin * 2,
            {
                ...baseOpts,
                roughness: 2.2,
                disableMultiStroke: true,
                fill: 'none',
            }
        );
        svgEl.appendChild(rect);
    }

    return svgEl;
}

// ---------------------------------------------------------------------------
// Animation  (called when the element enters the viewport)
// ---------------------------------------------------------------------------

function animateSVG(svgEl: SVGSVGElement) {
    svgEl.style.opacity = '1';

    const highlightGroup = svgEl.querySelector<SVGGElement>('[data-rgh-highlight]');

    if (highlightGroup) {
        // scaleX reveal left → right (GPU compositor, no repaint per frame)
        highlightGroup.style.transformOrigin = '0 0';
        highlightGroup.style.transform = 'scaleX(0)';
        highlightGroup.style.animation =
            `rgh-reveal ${DRAW_DURATION_MS}ms ease forwards`;
        return;
    }

    // stroke-dashoffset draw for circle / crossed-off
    const paths = svgEl.querySelectorAll<SVGPathElement>('path');
    const count = paths.length;
    paths.forEach((path, i) => {
        try {
            const len = path.getTotalLength();
            path.style.strokeDasharray = String(len);
            path.style.strokeDashoffset = String(len);
            // Each subsequent path in the same annotation (e.g. both lines of X)
            // starts slightly after the previous one finishes.
            const dur = DRAW_DURATION_MS;
            const delay = i * (dur / Math.max(count, 1)) * 0.5;
            path.style.animation =
                `rgh-draw ${dur}ms ease ${delay}ms forwards`;
        } catch {
            // getTotalLength unsupported in some edge cases
        }
    });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function setupAnnotations() {
    // ---- cleanup ----
    if (activeObserver) { activeObserver.disconnect(); activeObserver = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (resizeTimeout) { clearTimeout(resizeTimeout); resizeTimeout = null; }
    if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    snapListeners.forEach(({ el, type, fn }) => el.removeEventListener(type, fn));
    snapListeners = [];
    document.querySelectorAll('svg.rgh-annotation').forEach(s => s.remove());

    ensureStyles();

    // Early exit if this page has no annotatable elements
    if (!ANNOTATION_DEFS.some(d => document.querySelector(d.selector))) return;

    // ---- collect items ----
    const items: AnnotationItem[] = [];
    for (const def of ANNOTATION_DEFS) {
        const els: HTMLElement[] = def.multiple
            ? Array.from(document.querySelectorAll<HTMLElement>(def.selector))
            : ([document.querySelector<HTMLElement>(def.selector)].filter(Boolean) as HTMLElement[]);

        els.forEach((el, i) => {
            items.push({
                el,
                config: def.config,
                order: def.order + (def.multiple ? i * 0.1 : 0),
                svg: null,
            });
        });
    }
    if (items.length === 0) return;
    // Sort by actual document Y position so stagger follows visual top-to-bottom order
    // regardless of where on the page the user starts scrolling from.
    items.sort((a, b) => {
        const aY = a.el.getBoundingClientRect().top + window.scrollY;
        const bY = b.el.getBoundingClientRect().top + window.scrollY;
        return aY - bY;
    });

    // ---- build SVGs (hidden) and stamp index on element ----
    items.forEach((item, idx) => {
        item.svg = buildSVG(item.el, item.config);
        if (item.svg) document.body.appendChild(item.svg);
        item.el.dataset.rghIdx = String(idx);
    });

    // ---- live-track SVG positions for elements inside CSS-transitioning ancestors ----
    //
    // The SVG lives in document.body, so it can't inherit transforms from a parent like
    // .sticky. Instead, we run a rAF loop while the ancestor is transitioning so the SVG
    // follows the element's viewport position every frame (getBoundingClientRect() always
    // reflects the current post-transform position). The loop stops on transitionend.
    const ancestorSet = new Set<HTMLElement>();
    items.forEach(item => {
        if (!item.svg) return;
        let node: HTMLElement | null = item.el.parentElement;
        while (node && node !== document.body) {
            const t = window.getComputedStyle(node).transition;
            // Only track ancestors whose transition actually includes 'transform' —
            // elements with only border-color / box-shadow transitions don't move,
            // so the rAF loop is not needed (and stopFn would never fire for them).
            if (t && t !== 'none' && !t.startsWith('all 0s') && t.includes('transform')) {
                ancestorSet.add(node);
                break;
            }
            node = node.parentElement;
        }
    });

    ancestorSet.forEach(ancestor => {
        let rafId: number | null = null;

        const repositionChildren = () => {
            items.forEach(item => {
                if (!item.svg || !ancestor.contains(item.el)) return;
                const r = item.el.getBoundingClientRect();
                const [padTop, , , padLeft] = normalizePadding(item.config.padding);
                item.svg.style.top = `${r.top + window.scrollY - padTop}px`;
                item.svg.style.left = `${r.left + window.scrollX - padLeft}px`;
                item.svg.style.transform = '';
            });
        };

        const loop = () => {
            repositionChildren();
            rafId = requestAnimationFrame(loop);
        };

        const startFn: EventListener = () => {
            if (rafId === null) loop();
        };
        const stopFn: EventListener = (e: Event) => {
            // Ignore events from child elements and non-transform properties —
            // box-shadow and border-color also fire transitionend on the same
            // element and would kill the loop before the transform finishes.
            if (e.target !== ancestor) return;
            if ((e as TransitionEvent).propertyName !== 'transform') return;
            if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
            repositionChildren();
        };

        ancestor.addEventListener('mouseenter', startFn);
        ancestor.addEventListener('mouseleave', startFn);
        ancestor.addEventListener('transitionend', stopFn);
        snapListeners.push(
            { el: ancestor, type: 'mouseenter', fn: startFn },
            { el: ancestor, type: 'mouseleave', fn: startFn },
            { el: ancestor, type: 'transitionend', fn: stopFn },
        );

        // If mouse is already over the ancestor when listeners are registered,
        // mouseenter won't fire — start the loop immediately.
        if (ancestor.matches(':hover')) startFn(new Event('mouseenter'));
    });

    // ---- viewport-triggered animation ----
    //
    // Items are sorted by vertical document position (top to bottom).
    // The IntersectionObserver adds each element to `pending` when it enters
    // the viewport. On every flush, ALL pending (visible, not-yet-animated)
    // items fire in sorted order with a stagger between them — items that
    // haven't entered the viewport yet are skipped, not blocked.

    const pending = new Set<number>();
    const animated = new Set<number>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flush() {
        flushTimer = null;
        let staggerSlot = 0;
        for (let i = 0; i < items.length; i++) {
            if (animated.has(i)) continue;   // already done
            if (!pending.has(i)) continue;   // not in viewport yet — skip, don't block later items

            pending.delete(i);
            animated.add(i);
            // new
            if (activeObserver) activeObserver.unobserve(items[i].el);

            const item = items[i];
            const delay = staggerSlot * STAGGER_MS;
            staggerSlot++;

            setTimeout(() => {
                if (item.svg) animateSVG(item.svg);
            }, delay);
        }
    }

    activeObserver = new IntersectionObserver(
        (entries) => {
            let changed = false;
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const idx = parseInt((entry.target as HTMLElement).dataset.rghIdx ?? '-1');
                if (idx < 0 || animated.has(idx)) return;
                pending.add(idx);
                changed = true;
            });
            if (changed && !flushTimer) {
                flushTimer = setTimeout(flush, 40);   // small debounce
            }
        },
        { threshold: 0.15, rootMargin: '0px 0px -30px 0px' }
    );

    items.forEach(item => {
        if (item.svg) activeObserver!.observe(item.el);
    });

    // ---- resize: hide immediately, rebuild after debounce ----
    currentWidth = window.innerWidth;
    resizeHandler = () => {
        // new
        // Only rebuild when the width changes — on mobile the viewport height changes
        // constantly as the browser chrome (address bar) shows/hides while scrolling,
        // which would otherwise retrigger setupAnnotations() and replay all animations.
        if (window.innerWidth === currentWidth) return;
        currentWidth = window.innerWidth;
        // Hide all SVGs instantly so they don't visually drift during reflow
        document.querySelectorAll<SVGSVGElement>('svg.rgh-annotation').forEach(s => {
            s.style.opacity = '0';
        });
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => setupAnnotations(), 300);
    };
    window.addEventListener('resize', resizeHandler);
}
