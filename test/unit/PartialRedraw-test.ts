import { assert } from 'chai';

import {
  addStage,
  Konva,
  simulateMouseDown,
  simulateMouseMove,
  simulateMouseUp,
} from './test-utils.ts';
import type { Layer } from '../../src/Layer.ts';

function pixels(canvas: { _canvas: HTMLCanvasElement }) {
  const c = canvas._canvas;
  return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
}

// Chrome antialiases a shape that crosses the border of a redrawn region
// differently, which partialRedraw only avoids for shapes small enough to be
// taken into the region. Other rasterizers differ a little where a stroke
// overlaps itself. Such edge pixels differ by up to a quarter of their alpha,
// a missing or stale shape by its full alpha. Compared premultiplied, as the
// colour of a nearly transparent pixel is noise.
function sceneDiffers(a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) {
  for (let c = 0; c < 4; c++) {
    const scaleA = c === 3 ? 1 : a[i + 3] / 255;
    const scaleB = c === 3 ? 1 : b[i + 3] / 255;
    if (Math.abs(a[i + c] * scaleA - b[i + c] * scaleB) > 72) return true;
  }
  return false;
}

// The software hit canvas of WebKit antialiases thick strokes quite
// differently under a clip, so the hit graph is compared by what a pointer
// would hit: the shape whose key an opaque pixel holds, or none where the
// pixel is nearly transparent. Edge pixels, partly transparent or mixing the
// keys of two shapes, are skipped.
function hitShape(data: Uint8ClampedArray, i: number) {
  if (data[i + 3] < 64) return null;
  if (data[i + 3] < 192) return undefined;
  return Konva.shapes[
    Konva.Util.getHitColorKey(data[i], data[i + 1], data[i + 2])
  ];
}

function hitDiffers(a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) {
  const shapeA = hitShape(a, i),
    shapeB = hitShape(b, i);
  if (shapeA === undefined || shapeB === undefined) return false;
  return shapeA !== shapeB;
}

// Draws the pending changes, then checks that the scene and hit canvases
// match a full redraw. Returns whether the draw was partial.
function drawAndCompare(layer: Layer, message: string) {
  let partial = false;
  const drawRegions = layer._drawRegions;
  layer._drawRegions = function (...args) {
    partial = true;
    return drawRegions.apply(this, args);
  };
  try {
    layer._drawChanges();
  } finally {
    layer._drawRegions = drawRegions;
  }
  const partialPixels = [
    pixels(layer.getCanvas()),
    pixels(layer.getHitCanvas()),
  ];
  layer.draw();
  [layer.getCanvas(), layer.getHitCanvas()].forEach((canvas, n) => {
    const full = pixels(canvas);
    const differs = n ? hitDiffers : sceneDiffers;
    let i = -1;
    for (let p = 0; p < full.length && i < 0; p += 4) {
      if (differs(partialPixels[n], full, p)) i = p;
    }
    const width = canvas._canvas.width;
    const pixel = Math.floor(i / 4);
    assert.equal(
      i,
      -1,
      `${message}: ${n ? 'hit' : 'scene'} differs at ${pixel % width},${Math.floor(pixel / width)}: ` +
        `partial ${partialPixels[n].slice(pixel * 4, pixel * 4 + 4)}, full ${full.slice(pixel * 4, pixel * 4 + 4)}`
    );
  });
  return partial;
}

// large enough that a change stays a small part of it, so the redraw is
// partial and not merged into a full one
function createScene() {
  const stage = addStage({ width: 1000, height: 600 });
  const layer = new Konva.Layer({ partialRedraw: true });
  stage.add(layer);
  const group = new Konva.Group({ x: 40, y: 30, rotation: 10 });
  const rect = new Konva.Rect({
    x: 20,
    y: 20,
    width: 60,
    height: 40,
    fill: 'red',
    stroke: 'black',
    strokeWidth: 4,
  });
  const circle = new Konva.Circle({
    x: 200,
    y: 80,
    radius: 30,
    fill: 'blue',
    shadowColor: 'black',
    shadowBlur: 10,
    shadowOffsetX: 5,
  });
  // sharp angles: miter joins reach far past the points
  const line = new Konva.Line({
    points: [300, 20, 320, 120, 340, 20],
    stroke: 'green',
    strokeWidth: 8,
  });
  const ellipse = new Konva.Ellipse({
    x: 120,
    y: 150,
    radiusX: 40,
    radiusY: 30,
    stroke: 'purple',
    strokeWidth: 2,
    hitStrokeWidth: 30,
  });
  const text = new Konva.Text({
    x: 30,
    y: 120,
    text: 'Partial redraw',
    fontSize: 18,
    fontStyle: 'italic',
    fill: 'black',
  });
  group.add(rect);
  layer.add(group, circle, line, ellipse, text);
  layer.draw();
  return { stage, layer, group, rect, circle, line, ellipse, text };
}

describe('Layer partialRedraw', function () {
  it('is off by default', function () {
    const layer = new Konva.Layer();
    assert.equal(layer.partialRedraw(), false);
  });

  it('redraws attribute changes partially and pixel exact', function () {
    const { layer, group, rect, circle, line, ellipse, text } = createScene();
    const changes: Array<[string, () => void]> = [
      ['move', () => rect.x(rect.x() + 37)],
      ['fill', () => circle.fill('orange')],
      ['shadow', () => circle.shadowBlur(25)],
      ['group rotation', () => group.rotation(35)],
      ['line points', () => line.points([300, 30, 360, 140, 305, 60])],
      ['hit stroke', () => ellipse.x(160)],
      ['text', () => text.text('Changed text, longer')],
      ['hide', () => circle.visible(false)],
      ['show', () => circle.visible(true)],
      ['scale', () => rect.scale({ x: 1.5, y: 0.5 })],
      ['opacity', () => text.opacity(0.4)],
    ];
    for (const [name, change] of changes) {
      change();
      assert.isTrue(drawAndCompare(layer, name), `${name} is partial`);
    }
  });

  it('redraws structure changes partially', function () {
    const { layer, group, rect, circle, line, text } = createScene();
    const extra = new Konva.Rect({
      x: 150,
      y: 50,
      width: 80,
      height: 80,
      fill: 'yellow',
    });
    const changes: Array<[string, () => void]> = [
      ['add', () => layer.add(extra)],
      ['move to bottom', () => extra.moveToBottom()],
      ['move to top', () => extra.moveToTop()],
      ['z-index', () => extra.zIndex(1)],
      ['move to group', () => circle.moveTo(group)],
      ['remove', () => line.remove()],
      ['destroy', () => text.destroy()],
      ['add to group', () => group.add(line)],
      ['destroy children', () => group.destroyChildren()],
    ];
    for (const [name, change] of changes) {
      change();
      assert.isTrue(drawAndCompare(layer, name), `${name} is partial`);
    }
    assert.equal(rect.getParent(), null);
  });

  it('keeps several distant changes as separate regions', function () {
    const { layer, rect, line } = createScene();
    let regions: unknown[] = [];
    const drawRegions = layer._drawRegions;
    layer._drawRegions = function (canvas, r, draw) {
      regions = r;
      return drawRegions.call(this, canvas, r, draw);
    };
    rect.fill('pink');
    line.stroke('gray');
    drawAndCompare(layer, 'two changes');
    layer._drawRegions = drawRegions;
    assert.equal(regions.length, 2);
  });

  it('skips nodes outside of the changed area', function () {
    const { layer, rect } = createScene();
    let drawn = 0;
    const far = new Konva.Shape({
      x: 400,
      y: 150,
      fill: 'teal',
      sceneFunc(ctx, shape) {
        drawn++;
        ctx.beginPath();
        ctx.rect(0, 0, 30, 30);
        ctx.fillStrokeShape(shape);
      },
      selfRectFunc: () => ({ x: 0, y: 0, width: 30, height: 30 }),
    });
    layer.add(far);
    layer.draw();
    drawn = 0;
    rect.fill('pink');
    assert.isTrue(drawAndCompare(layer, 'far change'), 'far change');
    // only the full redraw of drawAndCompare drew it, for scene and hit
    assert.equal(drawn, 2);
  });

  it('draws the whole layer when the change can not be bounded', function () {
    const { stage, layer, rect } = createScene();
    const custom = new Konva.Shape({
      sceneFunc(ctx, shape) {
        ctx.beginPath();
        ctx.rect(0, 0, 300, 10);
        ctx.fillStrokeShape(shape);
      },
      fill: 'teal',
    });
    layer.add(custom);
    layer.draw();
    custom.y(100);
    assert.isFalse(
      drawAndCompare(layer, 'custom sceneFunc'),
      'custom sceneFunc'
    );

    rect.globalCompositeOperation('destination-in');
    assert.isFalse(drawAndCompare(layer, 'destination-in'), 'destination-in');

    stage.scale({ x: 1.2, y: 1.2 });
    assert.isFalse(drawAndCompare(layer, 'stage scale'), 'stage scale');

    layer.x(10);
    assert.isFalse(drawAndCompare(layer, 'layer move'), 'layer move');
  });

  it('a node with an unbounded composite operation stays correct when others change', function () {
    const { layer, rect, circle } = createScene();
    const eraser = new Konva.Circle({
      x: 210,
      y: 90,
      radius: 20,
      fill: 'black',
      globalCompositeOperation: 'destination-out',
    });
    layer.add(eraser);
    layer.draw();
    circle.x(190);
    assert.isTrue(drawAndCompare(layer, 'under eraser'), 'under eraser');
    rect.fill('green');
    assert.isTrue(
      drawAndCompare(layer, 'away from eraser'),
      'away from eraser'
    );
  });

  it('explicit batchDraw and draw redraw the whole layer', function () {
    const { layer, rect } = createScene();
    rect.fill('pink');
    layer.batchDraw();
    assert.isFalse(drawAndCompare(layer, 'batchDraw'), 'batchDraw');
  });

  it('does not redraw partially after the canvas was cleared', function () {
    const { layer, rect } = createScene();
    layer.clear();
    rect.fill('pink');
    assert.isFalse(drawAndCompare(layer, 'cleared'), 'cleared');
  });

  it('changes inside a cached group show after the cache is rebuilt', function () {
    const { layer, group, rect } = createScene();
    group.cache();
    assert.isTrue(drawAndCompare(layer, 'cache'), 'cache');
    // the group keeps showing its bitmap, so there is nothing to redraw
    rect.fill('pink');
    assert.isFalse(
      drawAndCompare(layer, 'change below cache'),
      'change below cache'
    );
    group.clearCache();
    assert.isTrue(drawAndCompare(layer, 'clear cache'), 'clear cache');
  });

  it('follows a transformer and the nodes it transforms', function () {
    const { layer, rect, circle } = createScene();
    const tr = new Konva.Transformer({ nodes: [circle], padding: 6 });
    layer.add(tr);
    layer.draw();
    circle.x(150);
    assert.isTrue(
      drawAndCompare(layer, 'move transformed node'),
      'move transformed node'
    );
    circle.radius(45);
    assert.isTrue(
      drawAndCompare(layer, 'resize transformed node'),
      'resize transformed node'
    );
    tr.nodes([rect]);
    assert.isTrue(drawAndCompare(layer, 'new selection'), 'new selection');
    tr.detach();
    assert.isTrue(drawAndCompare(layer, 'detach'), 'detach');
  });

  it('drag and drop redraws partially and restores the hit graph', function () {
    const { stage, layer, circle } = createScene();
    circle.draggable(true);
    layer.draw();
    simulateMouseDown(stage, { x: 200, y: 80 });
    simulateMouseMove(stage, { x: 220, y: 100 });
    simulateMouseMove(stage, { x: 260, y: 140 });
    assert.isTrue(drawAndCompare(layer, 'during drag'), 'during drag');
    simulateMouseUp(stage, { x: 260, y: 140 });
    assert.equal(circle.position().x, 260);
    assert.equal(layer.getIntersection({ x: 260, y: 140 }), circle);
    assert.equal(layer.getIntersection({ x: 200, y: 80 }), null);
  });

  it('adding and removing another layer does not redraw the layer', function () {
    const { stage, layer, rect } = createScene();
    let full = 0;
    layer.on('draw', () => full++);
    const other = new Konva.Layer();
    stage.add(other);
    other.destroy();
    rect.fill('pink');
    assert.isTrue(drawAndCompare(layer, 'after layer change'));
    // the draw event fires for the partial draw and the full compare draw
    assert.equal(full, 2);
  });

  it('works at a fractional pixel ratio', function () {
    const { layer, rect, line } = createScene();
    layer.getCanvas().setPixelRatio(1.37);
    layer.draw();
    rect.x(rect.x() + 13.3);
    assert.isTrue(drawAndCompare(layer, 'move'), 'move');
    line.points([300, 30, 360, 140, 305, 60]);
    assert.isTrue(drawAndCompare(layer, 'line'), 'line');
  });

  it('turning it on starts with a full draw', function () {
    const stage = addStage();
    const layer = new Konva.Layer();
    stage.add(layer);
    const rect = new Konva.Rect({ width: 50, height: 50, fill: 'red' });
    layer.add(rect);
    layer.draw();
    rect.x(10);
    layer.partialRedraw(true);
    rect.x(20);
    assert.isFalse(drawAndCompare(layer, 'first draw'), 'first draw');
    rect.x(30);
    assert.isTrue(drawAndCompare(layer, 'second draw'), 'second draw');
  });
});
