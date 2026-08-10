/**
 * DesmosBuilder
 * Converts polylines (arrays of {x,y} points, in graph coordinates) into
 * real Desmos expressions. Each contour becomes a single list-of-points
 * expression, filtered by a shared global variable `T` so that as `T`
 * increases, more of each contour is progressively revealed — this is
 * how the "drawing" animation is actually implemented, entirely inside
 * Desmos's own expression engine.
 */
export const DesmosBuilder = (function () {

  function fmt(n) {
    // Keep expressions compact while preserving enough precision for smooth curves.
    return Math.round(n * 1000) / 1000;
  }

  function buildExpressions(polylines) {
    const expressions = [];
    const meta = [];
    let offset = 0;

    polylines.forEach((poly, i) => {
      const n = poly.length;
      const pairs = poly
        .map((p) => `\\left(${fmt(p.x)},${fmt(p.y)}\\right)`)
        .join(',');

      // [(x1,y1),...,(xn,yn)] [ [1...n] <= min(max(T-offset,0),n) ]
      const latex =
        `\\left[${pairs}\\right]` +
        `\\left[\\left[1...${n}\\right]\\le\\min\\left(\\max\\left(T-${offset},0\\right),${n}\\right)\\right]`;

      expressions.push({
        id: 'contour_' + i,
        latex,
        color: '#000000',
        lines: true,
        points: false,
        lineWidth: 1.6,
        lineOpacity: 1,
        secret: false,
      });

      meta.push({ offset, length: n });
      offset += n;
    });

    return { expressions, meta, total: offset };
  }

  function buildTExpression(initial) {
    return { id: 'T', latex: `T=${initial || 0}`, secret: false };
  }

  return { buildExpressions, buildTExpression };
})();
