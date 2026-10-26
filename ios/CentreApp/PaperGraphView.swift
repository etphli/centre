import SwiftUI
import CentreCore

struct PaperGraphView: View {
    @Environment(\.centre) private var palette
    let value: JSONValue

    var body: some View {
        if let graph = PaperGraph.parse(value) {
            Canvas { context, size in
                let scale = size.width/100
                func point(_ x: Double,_ y: Double) -> CGPoint { CGPoint(x:x*scale,y:y*scale) }
                func line(_ start: CGPoint,_ end: CGPoint, color: Color, width: Double = 0.5) {
                    var path = Path(); path.move(to:start); path.addLine(to:end)
                    context.stroke(path,with:.color(color),lineWidth:width)
                }
                func text(_ label: String,_ x: Double,_ y: Double, anchor: UnitPoint = .center) {
                    context.draw(Text(label).font(.system(size:scale*2.7,design:.serif)).foregroundStyle(palette.text),at:point(x,y),anchor:anchor)
                }
                let origin = graph.project(x:0,y:0)
                for tick in graph.ticks(min:graph.xMin,max:graph.xMax) {
                    let p = graph.project(x:tick,y:0)
                    line(point(p.x,8),point(p.x,72),color:palette.line)
                    if tick != 0 { text(tick.formatted(),p.x,76) }
                }
                for tick in graph.ticks(min:graph.yMin,max:graph.yMax) {
                    let p = graph.project(x:0,y:tick)
                    line(point(12,p.y),point(94,p.y),color:palette.line)
                    if tick != 0 { text(tick.formatted(),10,p.y,anchor:.trailing) }
                }
                line(point(12,origin.y),point(96,origin.y),color:palette.text,width:1)
                line(point(origin.x,72),point(origin.x,5),color:palette.text,width:1)
                text("x",98,origin.y); text("y",origin.x,3)
                for (index,curve) in graph.curves.enumerated() {
                    for segment in graph.segments(curve) {
                        var path = Path()
                        for (i,p) in segment.enumerated() {
                            if i == 0 { path.move(to:point(p.x,p.y)) } else { path.addLine(to:point(p.x,p.y)) }
                        }
                        context.stroke(path,with:.color(palette.text),style:StrokeStyle(lineWidth:1.8,dash:index%2 == 0 ? []:[5,3]))
                    }
                }
                for (index,p) in graph.points.enumerated() {
                    let pos = graph.project(x:p.x,y:p.y)
                    context.fill(Path(ellipseIn:CGRect(x:pos.x*scale-2,y:pos.y*scale-2,width:4,height:4)),with:.color(palette.text))
                    let label = graph.labelPosition(index:index)
                    text(graph.pointLabel(index:index),label.x,label.y,anchor:label.alignLeft ? .trailing:.leading)
                }
                let legend = graph.curves.enumerated().filter { !$0.element.label.isEmpty }.map { "\($0.offset%2 == 0 ? "Solid":"Dashed"): \($0.element.label)" }.joined(separator:"; ")
                text(legend,12,82,anchor:.leading)
                for (index,label) in graph.pointKey.enumerated() { text(label,12,86+Double(index)*4,anchor:.leading) }
            }
            .aspectRatio(100.0/graph.height,contentMode:.fit)
            .accessibilityElement(children:.ignore)
            .accessibilityLabel(graph.curves.isEmpty ? "Blank Cartesian graph for sketching":"Plotted Cartesian graph")
            .accessibilityIdentifier("paper.graph")
        }
    }
}
