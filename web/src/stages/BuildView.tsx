import { useState } from 'react';
import { StageHeader } from '../ui/common';
import type { GraphNode } from '../trace/schema';
import { BlockGrid } from './BlockGrid';
import { NodeTooltip, OpGraph } from './OpGraph';
import type { ViewProps } from './types';

export function GraphBadge({ step }: { step: ViewProps['step'] }) {
  const g = step.graphEvent;
  return (
    <div className={`graph-badge ${g.reused ? 'reused' : 'built'}`} data-graph-reused={g.reused}>
      <span className="badge-word">{g.reused ? 'reused' : 'built'}</span>
      <span className="badge-kv"><span>graph_id</span>{g.graph_id}</span>
      <span className="badge-kv"><span>n_nodes</span>{g.n_nodes}</span>
      <span className="badge-kv"><span>n_leafs</span>{g.n_leafs}</span>
    </div>
  );
}

/** Op-level expansion with its controls; shared by Build and Dispatch */
export function Expansion({ graph, sel, onClose, width, height, execById, cursor }: {
  graph: ViewProps['step']['graph'];
  sel: { layer: number | null; block: number };
  onClose: () => void;
  width: number; height: number;
  execById?: ViewProps['step']['execById'];
  cursor?: number;
}) {
  const [collapse, setCollapse] = useState(true);
  const [hover, setHover] = useState<{ n: GraphNode | null; x: number; y: number }>({ n: null, x: 0, y: 0 });
  return (
    <div className="expansion">
      <div className="expansion-bar">
        <code>{graph.blocks.filter((b) => (sel.layer !== null ? b.layer === sel.layer : b.id === sel.block)).map((b) => b.name).join(' · ')}</code>
        <label><input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> collapse RESHAPE / VIEW / PERMUTE / TRANSPOSE</label>
        <button onClick={onClose}>close</button>
      </div>
      <OpGraph graph={graph} layer={sel.layer} blockId={sel.block} collapse={collapse} execById={execById} cursor={cursor}
        onHover={(n, x, y) => setHover({ n, x, y })} width={width} height={height} />
      <NodeTooltip node={hover.n} x={hover.x} y={hover.y} />
    </div>
  );
}

export function BuildView({ trace, step, p, record, width, height }: ViewProps) {
  const g = step.graph;
  const reused = step.graphEvent.reused;
  const n = g.blocks.length;
  const shown = reused ? n : Math.ceil(p * n + 0.0001);
  const [sel, setSel] = useState<{ layer: number | null; block: number } | null>(null);
  return (
    <div className="view build-view" data-stage-panel="build">
      <StageHeader trace={trace} keys={reused ? ['process_ubatch'] : ['process_ubatch', 'build_graph', ...(trace.info.sources.arch_graph ? ['arch_graph'] : [])]}
        extra={<GraphBadge step={step} />} />
      {sel && !record ? (
        <Expansion graph={g} sel={sel} onClose={() => setSel(null)} width={width - 48} height={height - 150} />
      ) : (
        <BlockGrid graph={g} compact={record}
          state={(_, i) => (i < shown ? 'shown' : 'hidden')}
          onSelect={record ? undefined : (layer, b) => setSel({ layer, block: b.id })} />
      )}
    </div>
  );
}
