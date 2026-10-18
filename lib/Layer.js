import { Util } from "./Util.js";
import { Container } from "./Container.js";
import { Node } from "./Node.js";
import { Factory } from "./Factory.js";
import { getBooleanValidator } from "./Validators.js";
import { SceneCanvas, HitCanvas } from "./Canvas.js";
import { shapes } from "./Shape.js";
import { _registerNode, Konva } from "./Global.js";
import { DD } from "./DragAndDrop.js";
// constants
const BEFORE_DRAW = 'beforeDraw', DRAW = 'draw', 
// getIntersection() reads the hit canvas around an edge pixel in blocks
// of this radius, doubling it as long as the search goes on
HIT_SEARCH_RADIUS = 10, HIT_SEARCH_MAX_DISTANCE = 256, 
// more dirty regions than this are merged into one, as every region costs
// a clip path entry and a culling test per node
MAX_DIRTY_REGIONS = 8, 
// a partial redraw of most of the canvas costs as much as a full one
MAX_DIRTY_AREA_SHARE = 0.6, 
// see _collectDirtyRegions
MAX_ABSORB_PASSES = 3, MAX_ABSORB_GROWTH = 3;
function intersects(a, b) {
    return (a.x <= b.x + b.width &&
        b.x <= a.x + a.width &&
        a.y <= b.y + b.height &&
        b.y <= a.y + a.height);
}
function contains(outer, inner) {
    return (inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height);
}
// merges the regions that touch, dropping empty ones
function mergeRegions(rects) {
    const regions = [];
    for (let region of rects) {
        if (!(region.width > 0 && region.height > 0))
            continue;
        for (let i = regions.length - 1; i >= 0; i--) {
            if (intersects(region, regions[i])) {
                region = union(region, regions[i]);
                regions.splice(i, 1);
                i = regions.length;
            }
        }
        regions.push(region);
    }
    return regions;
}
function union(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
}
// the shape drawn at a pixel of the hit graph: an opaque pixel, or an edge
// pixel that the shape covers by at least half, so that its colour read back
// premultiplied still rounds to the key of the shape (see getHitColorKey)
function getHitShape(data, i) {
    return data[i + 3] >= 128
        ? shapes[Util.getHitColorKey(data[i], data[i + 1], data[i + 2])]
        : undefined;
}
/**
 * Layer constructor.  Layers are tied to their own canvas element and are used
 * to contain groups or shapes.
 * @constructor
 * @memberof Konva
 * @augments Konva.Container
 * @param {Object} config
 * @param {Boolean} [config.clearBeforeDraw] set this property to false if you don't want
 * to clear the canvas before each layer draw.  The default value is true.
 * @param {Boolean} [config.partialRedraw] redraw only the areas that changed. See {@link Konva.Layer#partialRedraw}
 * @@nodeParams
 * @@containerParams
 * @example
 * var layer = new Konva.Layer();
 * stage.add(layer);
 * // now you can add shapes, groups into the layer
 */
export class Layer extends Container {
    constructor(config) {
        super(config);
        this.canvas = new SceneCanvas();
        this.hitCanvas = new HitCanvas({
            pixelRatio: 1,
        });
        this._waitingForDraw = false;
        // partialRedraw bookkeeping. Measured bounds are valid for one epoch, which
        // ends with every full draw, because only tracked changes keep them current
        this._paintEpoch = {};
        this._fullDrawPending = true;
        this._dirtyNodes = new Set();
        this._dirtyRects = [];
        // the hit graph missed changes because it was skipped during a drag or
        // transform, so the next hit draw can not be partial
        this._hitStale = false;
        // transformers with a deferred layout update, run before the dirty regions
        // are measured, so a draw that skips them still shows their new layout
        this._pendingUpdates = new Set();
        if (this.partialRedraw())
            Node._partialRedrawUsed = true;
        this.on('partialRedrawChange.konva', () => {
            if (this.partialRedraw())
                Node._partialRedrawUsed = true;
            this._fullDrawPending = true;
        });
        this.on('visibleChange.konva', this._checkVisibility);
        this._checkVisibility();
        this.on('imageSmoothingEnabledChange.konva', this._setSmoothEnabled);
        this._setSmoothEnabled();
    }
    // for nodejs?
    createPNGStream() {
        const c = this.canvas._canvas;
        return c.createPNGStream();
    }
    /**
     * get layer canvas wrapper
     * @method
     * @name Konva.Layer#getCanvas
     */
    getCanvas() {
        return this.canvas;
    }
    /**
     * get native canvas element
     * @method
     * @name Konva.Layer#getNativeCanvasElement
     */
    getNativeCanvasElement() {
        return this.canvas._canvas;
    }
    /**
     * get layer hit canvas
     * @method
     * @name Konva.Layer#getHitCanvas
     */
    getHitCanvas() {
        return this.hitCanvas;
    }
    /**
     * get layer canvas context
     * @method
     * @name Konva.Layer#getContext
     */
    getContext() {
        return this.getCanvas().getContext();
    }
    /**
     * clear the scene and hit canvas of the layer. The nodes stay and are
     * drawn again by the next `draw()`
     * @method
     * @name Konva.Layer#clear
     * @param {Object} [bounds] clear only this rectangle: `{ x, y, width, height }`
     * @returns {Konva.Layer}
     * @example
     * layer.clear();
     * layer.clear({ x: 0, y: 0, width: 100, height: 100 });
     */
    clear(bounds) {
        this._fullDrawPending = true;
        this.getContext().clear(bounds);
        this.getHitCanvas().getContext().clear(bounds);
        return this;
    }
    // extend Node.prototype.setZIndex
    setZIndex(index) {
        super.setZIndex(index);
        const stage = this.getStage();
        if (stage && stage.content) {
            stage.content.removeChild(this.getNativeCanvasElement());
            if (index < stage.children.length - 1) {
                stage.content.insertBefore(this.getNativeCanvasElement(), stage.children[index + 1].getCanvas()._canvas);
            }
            else {
                stage.content.appendChild(this.getNativeCanvasElement());
            }
        }
        return this;
    }
    moveToTop() {
        Node.prototype.moveToTop.call(this);
        const stage = this.getStage();
        if (stage && stage.content) {
            stage.content.removeChild(this.getNativeCanvasElement());
            stage.content.appendChild(this.getNativeCanvasElement());
        }
        return true;
    }
    moveUp() {
        const moved = Node.prototype.moveUp.call(this);
        if (!moved) {
            return false;
        }
        const stage = this.getStage();
        if (!stage || !stage.content) {
            return false;
        }
        stage.content.removeChild(this.getNativeCanvasElement());
        if (this.index < stage.children.length - 1) {
            stage.content.insertBefore(this.getNativeCanvasElement(), stage.children[this.index + 1].getCanvas()._canvas);
        }
        else {
            stage.content.appendChild(this.getNativeCanvasElement());
        }
        return true;
    }
    // extend Node.prototype.moveDown
    moveDown() {
        if (Node.prototype.moveDown.call(this)) {
            const stage = this.getStage();
            if (stage) {
                const children = stage.children;
                if (stage.content) {
                    stage.content.removeChild(this.getNativeCanvasElement());
                    stage.content.insertBefore(this.getNativeCanvasElement(), children[this.index + 1].getCanvas()._canvas);
                }
            }
            return true;
        }
        return false;
    }
    // extend Node.prototype.moveToBottom
    moveToBottom() {
        if (Node.prototype.moveToBottom.call(this)) {
            const stage = this.getStage();
            if (stage) {
                const children = stage.children;
                if (stage.content) {
                    stage.content.removeChild(this.getNativeCanvasElement());
                    stage.content.insertBefore(this.getNativeCanvasElement(), children[1].getCanvas()._canvas);
                }
            }
            return true;
        }
        return false;
    }
    getLayer() {
        return this;
    }
    remove() {
        var _a, _b;
        super.remove();
        // both canvases live in stage.content: the scene one always, the hit one
        // while toggleHitCanvas() shows it
        const scene = this.getNativeCanvasElement();
        const hit = this.getHitCanvas()._canvas;
        (_a = scene.parentNode) === null || _a === void 0 ? void 0 : _a.removeChild(scene);
        (_b = hit.parentNode) === null || _b === void 0 ? void 0 : _b.removeChild(hit);
        return this;
    }
    getStage() {
        return this.parent;
    }
    // the canvases follow the stage size. The public size() of a layer, like
    // width() and height(), warns and does nothing
    _setSize({ width, height }) {
        // resizing wipes the canvas
        this._fullDrawPending = true;
        this.canvas.setSize(width, height);
        this._syncHitCanvasSize();
        this._setSmoothEnabled();
        return this;
    }
    // the hit canvas is only allocated while the layer is listening;
    // for a non-listening layer it is kept released (0x0), so a purely
    // presentational layer does not pay for a stage-sized hit bitmap
    // https://github.com/konvajs/konva/issues/2009
    _syncHitCanvasSize() {
        const listening = this.isListening();
        this.hitCanvas.setSizeIfChanged((listening ? this.getWidth() : 0) || 0, (listening ? this.getHeight() : 0) || 0);
    }
    _validateAdd(child) {
        const type = child.getType();
        if (type !== 'Group' && type !== 'Shape') {
            Util.throw('You may only add groups and shapes to a layer.');
        }
    }
    _toKonvaCanvas(config) {
        config = { ...config };
        config.width = config.width || this.getWidth();
        config.height = config.height || this.getHeight();
        config.x = config.x !== undefined ? config.x : this.x();
        config.y = config.y !== undefined ? config.y : this.y();
        return Node.prototype._toKonvaCanvas.call(this, config);
    }
    _checkVisibility() {
        const visible = this.visible();
        if (visible) {
            this.canvas._canvas.style.display = 'block';
        }
        else {
            this.canvas._canvas.style.display = 'none';
        }
    }
    _setSmoothEnabled() {
        this.getContext()._context.imageSmoothingEnabled =
            this.imageSmoothingEnabled();
    }
    /**
     * get/set width of layer. getter return width of stage. setter doing nothing.
     * if you want change width use `stage.width(value);`
     * @name Konva.Layer#width
     * @method
     * @returns {Number}
     * @example
     * var width = layer.width();
     */
    getWidth() {
        if (this.parent) {
            return this.parent.width();
        }
    }
    setWidth() {
        Util.warn('Can not change width of layer. Use "stage.width(value)" function instead.');
    }
    /**
     * get/set height of layer.getter return height of stage. setter doing nothing.
     * if you want change height use `stage.height(value);`
     * @name Konva.Layer#height
     * @method
     * @returns {Number}
     * @example
     * var height = layer.height();
     */
    getHeight() {
        if (this.parent) {
            return this.parent.height();
        }
    }
    setHeight() {
        Util.warn('Can not change height of layer. Use "stage.height(value)" function instead.');
    }
    /**
     * batch draw. this function will not do immediate draw
     * but it will schedule drawing to next tick (requestAnimFrame)
     * @method
     * @name Konva.Layer#batchDraw
     * @return {Konva.Layer} this
     */
    batchDraw() {
        // the caller may have changed something that is not tracked, like the
        // pixels of a drawn image, so the whole layer is drawn
        this._fullDrawPending = true;
        return this._batchDrawChanges();
    }
    // like batchDraw(), but with partialRedraw only the changed areas are drawn
    _batchDrawChanges() {
        var _a;
        if (!this._waitingForDraw) {
            this._waitingForDraw = true;
            // ask the window the stage is rendered in for the frame: a stage in a
            // popout window keeps drawing while the opener window is not visible
            Util.requestAnimFrame(() => {
                // reset before drawing, so a throwing draw does not freeze the layer
                // and a draw handler can request the next frame
                this._waitingForDraw = false;
                this._drawChanges();
            }, (_a = this.getStage()) === null || _a === void 0 ? void 0 : _a._getOwnerWindow());
        }
        return this;
    }
    draw() {
        this._fullDrawPending = true;
        return this._drawChanges();
    }
    _drawChanges() {
        for (const node of this._pendingUpdates)
            node._syncUpdate();
        this._pendingUpdates.clear();
        const regions = this._fullDrawPending ||
            !this.partialRedraw() ||
            !this.clearBeforeDraw() ||
            !this.canvas.width ||
            !this.canvas.height
            ? null
            : this._collectDirtyRegions();
        this._fullDrawPending = false;
        this._dirtyNodes.clear();
        this._dirtyRects = [];
        if (!regions) {
            this._paintEpoch = {};
            return super.draw();
        }
        if (regions.length) {
            this._drawRegions(this.canvas, regions, () => this.drawScene());
        }
        if (this._hitStale) {
            this.drawHit();
        }
        else if (regions.length) {
            this._drawRegions(this.hitCanvas, regions, () => this.drawHit());
        }
        return this;
    }
    // records the area a node painted before it changes, see partialRedraw()
    _invalidate(node) {
        // undefined while the Node constructor sets attributes, before the
        // fields of the layer exist; the first draw is a full one anyway
        if (this._fullDrawPending !== false || this._dirtyNodes.has(node)) {
            return;
        }
        if (node === this) {
            this._fullDrawPending = true;
            return;
        }
        // a cached ancestor keeps showing its bitmap until it is cached again
        for (let p = node.parent; p && p !== this; p = p.parent) {
            if (p.isCached())
                return;
        }
        const rect = node.isVisible()
            ? node._getPaintRect(this._paintEpoch)
            : undefined;
        if (rect === null) {
            this._fullDrawPending = true;
            return;
        }
        if (rect)
            this._dirtyRects.push(rect);
        this._dirtyNodes.add(node);
        node._forgetPaint();
        for (let p = node.parent; p && p !== this; p = p.parent) {
            p._paintEpoch = undefined;
        }
    }
    // old and new areas of the changed nodes, merged and clamped to the
    // canvas, or null when a full draw is needed
    _collectDirtyRegions() {
        const rects = this._dirtyRects;
        for (const node of this._dirtyNodes) {
            if (node.getLayer() !== this || !node.isVisible())
                continue;
            let cached = false;
            for (let p = node.parent; p && p !== this; p = p.parent) {
                if (p.isCached())
                    cached = true;
            }
            if (cached)
                continue;
            const rect = node._getPaintRect(this._paintEpoch);
            if (rect === null)
                return null;
            if (rect)
                rects.push(rect);
        }
        const width = this.getWidth() || 0, height = this.getHeight() || 0;
        const clamp = (rect) => {
            const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
            return {
                x,
                y,
                width: Math.min(width, rect.x + rect.width) - x,
                height: Math.min(height, rect.y + rect.height) - y,
            };
        };
        let regions = mergeRegions(rects.map(clamp));
        // Chrome rasterizes a shape that crosses the border of a clip with
        // different antialiasing than without the clip, while a shape inside the
        // clip comes out the same. So regions grow over the shapes crossing them,
        // within a budget of area: a shape too large for it keeps slightly
        // different edges inside the region until the next full draw
        const area = (list) => list.reduce((sum, r) => sum + r.width * r.height, 0);
        let budget = area(regions) * MAX_ABSORB_GROWTH;
        for (let pass = 0; pass < MAX_ABSORB_PASSES; pass++) {
            let grown = false;
            const visit = (container) => {
                for (const child of container.children) {
                    const paint = child._getPaintRect(this._paintEpoch);
                    if (!paint)
                        continue;
                    const rect = clamp(paint);
                    for (let i = 0; i < regions.length; i++) {
                        const region = regions[i];
                        if (!intersects(rect, region) || contains(region, rect))
                            continue;
                        if (child instanceof Container && !child.isCached()) {
                            visit(child);
                            break;
                        }
                        const bigger = union(region, rect);
                        const cost = bigger.width * bigger.height - region.width * region.height;
                        if (cost <= budget) {
                            budget -= cost;
                            regions[i] = bigger;
                            grown = true;
                        }
                    }
                }
            };
            visit(this);
            if (!grown)
                break;
            regions = mergeRegions(regions);
        }
        if (regions.length > MAX_DIRTY_REGIONS) {
            regions = [regions.reduce(union)];
        }
        if (area(regions) > width * height * MAX_DIRTY_AREA_SHARE) {
            return null;
        }
        return regions;
    }
    // clips the canvas to the regions, widened to whole device pixels so that
    // the edges of the clip are not antialiased, and lets draw() clear and
    // paint only there, skipping the nodes outside of them
    _drawRegions(canvas, regions, draw) {
        if (!canvas.width || !canvas.height) {
            return;
        }
        const ratio = canvas.getPixelRatio(), context = canvas.getContext()._context, clipped = [];
        context.save();
        context.beginPath();
        for (const r of regions) {
            // one more pixel for antialiasing that leaks past the measured bounds
            const x = Math.floor(r.x * ratio) - 1, y = Math.floor(r.y * ratio) - 1, rect = {
                x: x / ratio,
                y: y / ratio,
                width: (Math.ceil((r.x + r.width) * ratio) + 1 - x) / ratio,
                height: (Math.ceil((r.y + r.height) * ratio) + 1 - y) / ratio,
            };
            context.rect(rect.x, rect.y, rect.width, rect.height);
            clipped.push(rect);
        }
        context.clip();
        // cleared region by region instead of by the draw: some backends clear
        // the whole canvas when clearRect() covers it, ignoring the clip. One
        // pixel wider than the clip, as WebKit leaves the pixels on the border
        // of the clip partly uncleared otherwise
        const border = 1 / ratio;
        for (const r of clipped) {
            context.clearRect(r.x - border, r.y - border, r.width + border * 2, r.height + border * 2);
        }
        canvas._partial = { regions: clipped, epoch: this._paintEpoch };
        try {
            draw();
        }
        finally {
            canvas._partial = undefined;
            context.restore();
        }
    }
    /**
     * get visible intersection shape. This is the preferred
     * method for determining if a point intersects a shape or not.
     * It reads the hit canvas, so it finds what pointer events would: nodes with
     * listening set to false or invisible nodes are not detected, a shape with opacity 0
     * is, and `hitStrokeWidth` counts. The position is relative to the top left corner of the
     * stage container, like `stage.getPointerPosition()`, without the stage transform
     * @method
     * @name Konva.Layer#getIntersection
     * @param {Object} pos
     * @param {Number} pos.x
     * @param {Number} pos.y
     * @returns {Konva.Node}
     * @example
     * var shape = layer.getIntersection({x: 50, y: 50});
     */
    getIntersection(pos) {
        if (!this.isListening() || !this.isVisible()) {
            return null;
        }
        const hit = this._getIntersection(pos);
        if (hit.shape) {
            return hit.shape;
        }
        if (!hit.antialiased) {
            return null;
        }
        // the pointer is on the outer part of an edge, or on an opaque pixel with
        // the colours of two shapes mixed. Walk outward ring by ring to the
        // nearest pixel that resolves to a shape. The smoothed edge of a cached
        // node that is scaled up can be many pixels wide, so keep going while the
        // alpha still rises (the ramp leads into the shape) or the ring holds
        // mixed pixels. A thin line has a flat alpha, so the search stops at once
        // instead of walking along it to an unrelated shape nearby
        const ratio = this.hitCanvas.pixelRatio, cx = Math.floor(pos.x * ratio), cy = Math.floor(pos.y * ratio);
        const read = (r) => this.hitCanvas.context.getImageData(cx - r, cy - r, r * 2 + 1, r * 2 + 1)
            .data;
        let r = HIT_SEARCH_RADIUS, size = r * 2 + 1, data = read(r), previousMax = data[(r * size + r) * 4 + 3];
        for (let d = 1; d <= HIT_SEARCH_MAX_DISTANCE; d++) {
            if (d > r) {
                r = Math.min(HIT_SEARCH_MAX_DISTANCE, r * 2);
                size = r * 2 + 1;
                data = read(r);
            }
            let max = 0;
            for (let y = -d; y <= d; y++) {
                // whole top and bottom rows, only the two side pixels of the others
                const step = Math.abs(y) === d ? 1 : d * 2;
                for (let x = -d; x <= d; x += step) {
                    const i = ((y + r) * size + x + r) * 4;
                    const shape = getHitShape(data, i);
                    if (shape) {
                        return shape;
                    }
                    max = Math.max(max, data[i + 3]);
                }
            }
            // 255 here is a mixed pixel, as an opaque one resolved above
            if (max <= previousMax && max !== 255) {
                return null;
            }
            previousMax = max;
        }
        return null;
    }
    _getIntersection(pos) {
        // a non-listening layer keeps its hit canvas released (0x0),
        // and a just-enabled layer may not have drawn its hit graph yet
        if (!this.hitCanvas.width || !this.hitCanvas.height) {
            return {};
        }
        const ratio = this.hitCanvas.pixelRatio;
        const p = this.hitCanvas.context.getImageData(Math.floor(pos.x * ratio), Math.floor(pos.y * ratio), 1, 1).data;
        const shape = getHitShape(p, 0);
        if (shape) {
            return { shape };
        }
        if (p[3] > 0) {
            // an edge pixel, or an opaque one with the colours of two shapes mixed
            return { antialiased: true };
        }
        return {};
    }
    drawScene(can, top) {
        const layer = this.getLayer(), canvas = can || (layer && layer.getCanvas());
        this._fire(BEFORE_DRAW, {
            node: this,
        });
        if (this.clearBeforeDraw() && !canvas._partial) {
            canvas.getContext().clear();
        }
        Container.prototype.drawScene.call(this, canvas, top);
        canvas._trimIsolationCanvas();
        this._fire(DRAW, {
            node: this,
        });
        return this;
    }
    // the hit graph is skipped while a node of the layer (or the stage) is
    // dragged or a transformer on the layer, or of a node on it, is
    // transforming, as the layer is redrawn every frame; the draw that follows
    // restores it
    shouldDrawHit(top) {
        var _a;
        if (!super.shouldDrawHit(top)) {
            return false;
        }
        if (top || Konva.hitOnDragEnabled) {
            return true;
        }
        let underDrag = false;
        DD._dragElements.forEach((elem) => {
            if (elem.dragStatus === 'dragging' &&
                (elem.node === this.getStage() || elem.node.getLayer() === this)) {
                underDrag = true;
            }
        });
        return !underDrag && !((_a = Konva['Transformer']) === null || _a === void 0 ? void 0 : _a._isLayerTransforming(this));
    }
    drawHit(can, top) {
        const layer = this.getLayer(), canvas = can || (layer && layer.hitCanvas);
        if (!can && layer) {
            // allocate or release the hit canvas to match the current listening
            // state - this also picks up a listening change made after the last draw
            layer._syncHitCanvasSize();
            const skipped = !layer.shouldDrawHit();
            // a skipped hit graph is cleared once and stays empty until redrawn
            if (layer.clearBeforeDraw() &&
                !canvas._partial &&
                !(skipped && layer._hitStale)) {
                layer.getHitCanvas().getContext().clear();
            }
            layer._hitStale = skipped;
        }
        Container.prototype.drawHit.call(this, canvas, top);
        return this;
    }
    /**
     * enable hit graph. **DEPRECATED!** Use `layer.listening(true)` instead.
     * @name Konva.Layer#enableHitGraph
     * @method
     * @returns {Layer}
     */
    enableHitGraph() {
        this.hitGraphEnabled(true);
        return this;
    }
    /**
     * disable hit graph. **DEPRECATED!** Use `layer.listening(false)` instead.
     * @name Konva.Layer#disableHitGraph
     * @method
     * @returns {Layer}
     */
    disableHitGraph() {
        this.hitGraphEnabled(false);
        return this;
    }
    setHitGraphEnabled(val) {
        Util.warn('hitGraphEnabled method is deprecated. Please use layer.listening() instead.');
        this.listening(val);
    }
    getHitGraphEnabled(val) {
        Util.warn('hitGraphEnabled method is deprecated. Please use layer.listening() instead.');
        return this.listening();
    }
    /**
     * Show or hide hit canvas over the stage. May be useful for debugging custom hitFunc
     * @name Konva.Layer#toggleHitCanvas
     * @method
     */
    toggleHitCanvas() {
        if (!this.parent || !this.parent['content']) {
            return;
        }
        const parent = this.parent;
        const added = !!this.hitCanvas._canvas.parentNode;
        if (added) {
            parent.content.removeChild(this.hitCanvas._canvas);
        }
        else {
            parent.content.appendChild(this.hitCanvas._canvas);
        }
    }
    destroy() {
        this.getCanvas()._releaseIsolationCanvas();
        Util.releaseCanvas(this.getNativeCanvasElement(), this.getHitCanvas()._canvas);
        return super.destroy();
    }
}
Layer.prototype.nodeType = 'Layer';
_registerNode(Layer);
/**
 * get/set imageSmoothingEnabled flag
 * For more info see https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/imageSmoothingEnabled
 * @name Konva.Layer#imageSmoothingEnabled
 * @method
 * @param {Boolean} imageSmoothingEnabled
 * @returns {Boolean}
 * @example
 * // get imageSmoothingEnabled flag
 * var imageSmoothingEnabled = layer.imageSmoothingEnabled();
 *
 * layer.imageSmoothingEnabled(false);
 *
 * layer.imageSmoothingEnabled(true);
 */
Factory.addGetterSetter(Layer, 'imageSmoothingEnabled', true);
/**
 * get/set clearBeforeDraw flag which determines if the layer is cleared or not
 *  before drawing
 * @name Konva.Layer#clearBeforeDraw
 * @method
 * @param {Boolean} clearBeforeDraw
 * @returns {Boolean}
 * @example
 * // get clearBeforeDraw flag
 * var clearBeforeDraw = layer.clearBeforeDraw();
 *
 * // disable clear before draw
 * layer.clearBeforeDraw(false);
 *
 * // enable clear before draw
 * layer.clearBeforeDraw(true);
 */
Factory.addGetterSetter(Layer, 'clearBeforeDraw', true);
/**
 * get/set partialRedraw flag. When enabled, a change of a node redraws only the
 * area the node painted before and paints now, instead of the whole layer:
 * the canvas is clipped to that area and nodes outside of it are skipped.
 * The cost of a frame then depends on the size of the change, not on the size
 * of the canvas. That matters most where canvas drawing is rasterized on the CPU,
 * like Safari, and for large or high-resolution canvases.
 *
 * Changes made through Konva (attributes, adding, removing, reordering, caching) are
 * tracked. `layer.draw()`, `layer.batchDraw()` and `Konva.Animation` still redraw the
 * whole layer, as they may follow a change Konva can not see, like new pixels of an image.
 * Call them after such a change, and avoid calling them after tracked changes.
 *
 * A change of a node whose painted area is not known also redraws the whole layer:
 * a custom `sceneFunc` without `selfRectFunc`, a custom `hitFunc`, or a
 * `globalCompositeOperation` that affects pixels outside the node, like `destination-in`.
 * A layer with `clearBeforeDraw(false)` is always drawn whole.
 * @name Konva.Layer#partialRedraw
 * @method
 * @param {Boolean} partialRedraw
 * @returns {Boolean}
 * @example
 * var layer = new Konva.Layer({ partialRedraw: true });
 *
 * // moving the shape redraws only the area around its old and new position
 * shape.x(shape.x() + 10);
 */
Factory.addGetterSetter(Layer, 'partialRedraw', false, getBooleanValidator());
// the getter and setter are the deprecated ones above
Factory.addOverloadedGetterSetter(Layer, 'hitGraphEnabled');
/**
 * get/set hitGraphEnabled flag.  **DEPRECATED!** Use `layer.listening(false)` instead.
 *  Disabling the hit graph will greatly increase
 *  draw performance because the hit graph will not be redrawn each time the layer is
 *  drawn.  This, however, also disables mouse/touch event detection
 * @name Konva.Layer#hitGraphEnabled
 * @method
 * @param {Boolean} enabled
 * @returns {Boolean}
 * @example
 * // get hitGraphEnabled flag
 * var hitGraphEnabled = layer.hitGraphEnabled();
 *
 * // disable hit graph
 * layer.hitGraphEnabled(false);
 *
 * // enable hit graph
 * layer.hitGraphEnabled(true);
 */
