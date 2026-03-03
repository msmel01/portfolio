import rough from 'roughjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnnotationConfig {
    type: 'highlight' | 'crossed-off' | 'circle';
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
    { selector: '.checkbox-square',  order: 0, config: { type: 'crossed-off', padding: 5,                 strokeWidth: 1.5, color: '#5703EF', iterations: 1 } },
    { selector: '.personal-line-1',  order: 1, config: { type: 'highlight',   padding: 5,                 strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    { selector: '.personal-line-2',  order: 2, config: { type: 'highlight',   padding: 5,                 strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    { selector: '.personal-line-3',  order: 3, config: { type: 'highlight',   padding: 5,                 strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    { selector: '.personal-line-4',  order: 4, config: { type: 'highlight',   padding: [5, 5, 5, 5],      strokeWidth: 1.5, color: '#F5DF4D', multiline: true } },
    { selector: '.now-link',         order: 5, config: { type: 'circle',      padding: [0, 2, 3, 8],      color: '#5703EF', iterations: 1 } },
    { selector: '.skill-text',       order: 6, config: { type: 'highlight',   padding: 5,                 strokeWidth: 1.5, color: '#F5DF4D' }, multiple: true },
    { selector: '.project-link',     order: 7, config: { type: 'circle',      padding: [0, 10, 5, 10],    color: '#5703EF', iterations: 1 } },
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
let currentWidth = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePadding(p: number | number[] | undefined): [number, number, number, number] {
    if (p === undefined)    return [5, 5, 5, 5];
    if (typeof p === 'number') return [p, p, p, p];
    if (p.length === 2)     return [p[0], p[1], p[0], p[1]];
    if (p.length === 4)     return p as [number, number, number, number];
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
        /* left-to-right reveal for highlight fill */
        @keyframes rgh-reveal {
            from { clip-path: inset(0 100% 0 0); }
            to   { clip-path: inset(0 0%   0 0); }
        }
    `;
    document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// SVG construction  (hidden until animated)
// ---------------------------------------------------------------------------

/**
 * Walk up the ancestor chain and accumulate any CSS rotation (in degrees).
 * Computed transforms are returned as matrix(a,b,c,d,e,f); the rotation
 * angle is atan2(b, a).
 */
function getAncestorRotationDeg(el: HTMLElement): number {
    let total = 0;
    let node: HTMLElement | null = el.parentElement;
    while (node && node !== document.body) {
        const t = window.getComputedStyle(node).transform;
        if (t && t !== 'none') {
            const m = t.match(/^matrix\(([^)]+)\)/);
            if (m) {
                const [a, b] = m[1].split(',').map(Number);
                total += Math.atan2(b, a) * (180 / Math.PI);
            }
        }
        node = node.parentElement;
    }
    return total;
}

function buildSVG(el: HTMLElement, config: AnnotationConfig): SVGSVGElement | null {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const [padTop, padRight, padBottom, padLeft] = normalizePadding(config.padding);
    const svgW  = rect.width  + padLeft + padRight;
    const svgH  = rect.height + padTop  + padBottom;

    // Position in document coordinates
    const cssTop  = rect.top  + window.scrollY - padTop;
    const cssLeft = rect.left + window.scrollX - padLeft;

    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgEl.setAttribute('width',   String(svgW));
    svgEl.setAttribute('height',  String(svgH));
    svgEl.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
    svgEl.classList.add('rgh-annotation');

    // If the element sits inside a rotated ancestor (e.g. the tilted sticky note),
    // rotate the SVG to match so it wraps the text correctly.
    const rotationDeg = getAncestorRotationDeg(el);
    const transformStyle = rotationDeg !== 0
        ? `transform-origin:center;transform:rotate(${rotationDeg}deg)`
        : '';

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
        'opacity:0',           // starts hidden; set to 1 in animateSVG
        ...(transformStyle ? [transformStyle] : []),
    ].join(';');

    const seed = (Math.abs(Math.round(cssTop * cssLeft)) % 9999) + 1;
    const rc   = rough.svg(svgEl);

    const baseOpts = {
        roughness:    1.8,
        strokeWidth:  config.strokeWidth ?? 1.5,
        stroke:       config.color ?? '#000',
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
            // Convert each line rect into SVG-local coordinates.
            // SVG origin is at (cssLeft, cssTop) in document space.
            const lx = (lineRect.left + window.scrollX) - cssLeft;
            const ly = (lineRect.top  + window.scrollY) - cssTop;
            const lw = lineRect.width;
            const lh = lineRect.height;
            const lineSeed = (seed + i * 37) % 9999 || 1;

            const node = rc.rectangle(lx, ly, lw, lh, {
                ...baseOpts,
                seed:        lineSeed,
                fill:        baseColor,
                fillStyle:   'solid',
                stroke:      'none',
                strokeWidth: 0,
                roughness:   1,
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
        const line1 = rc.line(scaleX,        scaleY,        svgW - scaleX, svgH - scaleY, crossedOpts);
        const line2 = rc.line(svgW - scaleX, scaleY,        scaleX,        svgH - scaleY, crossedOpts);
        svgEl.appendChild(line1);
        svgEl.appendChild(line2);

    } else if (config.type === 'circle') {
        const node = rc.ellipse(
            svgW / 2, svgH / 2,
            svgW - 4, svgH - 4,
            { ...baseOpts, roughness: 2, disableMultiStroke: true }
        );
        svgEl.appendChild(node);
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
        // Clip-path reveal left → right
        highlightGroup.style.clipPath = 'inset(0 100% 0 0)';
        highlightGroup.style.animation =
            `rgh-reveal ${DRAW_DURATION_MS}ms ease forwards`;
        return;
    }

    // stroke-dashoffset draw for circle / crossed-off
    const paths = svgEl.querySelectorAll<SVGPathElement>('path');
    const count  = paths.length;
    paths.forEach((path, i) => {
        try {
            const len = path.getTotalLength();
            path.style.strokeDasharray  = String(len);
            path.style.strokeDashoffset = String(len);
            // Each subsequent path in the same annotation (e.g. both lines of X)
            // starts slightly after the previous one finishes.
            const dur   = DRAW_DURATION_MS;
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
    if (activeObserver)  { activeObserver.disconnect();  activeObserver  = null; }
    if (resizeObserver)  { resizeObserver.disconnect();  resizeObserver  = null; }
    if (resizeTimeout)   { clearTimeout(resizeTimeout);  resizeTimeout   = null; }
    if (resizeHandler)   { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
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
                order:  def.order + (def.multiple ? i * 0.1 : 0),
                svg:    null,
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
        item.el.dataset.rghIdx = String(idx);     // used by observer below
    });

    // ---- viewport-triggered animation ----
    //
    // Items are sorted by vertical document position (top to bottom).
    // The IntersectionObserver adds each element to `pending` when it enters
    // the viewport. On every flush, ALL pending (visible, not-yet-animated)
    // items fire in sorted order with a stagger between them — items that
    // haven't entered the viewport yet are skipped, not blocked.

    const pending  = new Set<number>();
    const animated = new Set<number>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flush() {
        flushTimer = null;
        let staggerSlot = 0;
        for (let i = 0; i < items.length; i++) {
            if (animated.has(i)) continue;   // already done
            if (!pending.has(i))  continue;   // not in viewport yet — skip, don't block later items

            pending.delete(i);
            animated.add(i);

            const item  = items[i];
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
        // Hide all SVGs instantly so they don't visually drift during reflow
        document.querySelectorAll<SVGSVGElement>('svg.rgh-annotation').forEach(s => {
            s.style.opacity = '0';
        });
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => setupAnnotations(), 300);
    };
    window.addEventListener('resize', resizeHandler);
}
