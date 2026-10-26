import { memo } from 'react';
import type { CartesianGraph } from './paper-layout';
import { graphSvg } from './paper-graph';

export const PaperGraph = memo(function PaperGraph({graph}:{graph:CartesianGraph}) {
  return <div className="paper-graph" style={{maxWidth:520,width:'100%'}} dangerouslySetInnerHTML={{__html:graphSvg(graph)}} />;
});
