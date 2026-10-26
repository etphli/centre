import Foundation

public struct PaperGraph: Decodable, Equatable {
    public struct Curve: Decodable, Equatable { public let a: Double; public let b: Double; public let c: Double; public let label: String }
    public struct Point: Decodable, Equatable { public let x: Double; public let y: Double; public let label: String }
    public let xMin: Double, xMax: Double, yMin: Double, yMax: Double
    public let curves: [Curve]
    public let points: [Point]

    public static func parse(_ value: JSONValue) -> PaperGraph? {
        guard let graph = try? value.decode(PaperGraph.self),
              graph.xMin < 0, graph.xMax > 0, graph.yMin < 0, graph.yMax > 0,
              graph.xMax-graph.xMin >= 0.01, graph.yMax-graph.yMin >= 0.01,
              [graph.xMin,graph.xMax,graph.yMin,graph.yMax].allSatisfy(validNumber),
              graph.curves.count <= 4, graph.points.count <= 12,
              graph.curves.allSatisfy({ [ $0.a,$0.b,$0.c ].allSatisfy(validNumber) && $0.label.count <= 40 }),
              graph.points.allSatisfy({ validNumber($0.x) && validNumber($0.y) && $0.label.count <= 60 &&
                  $0.x >= graph.xMin && $0.x <= graph.xMax && $0.y >= graph.yMin && $0.y <= graph.yMax }) else { return nil }
        return graph
    }
    private static func validNumber(_ value: Double) -> Bool { value.isFinite && abs(value) <= 10000 }

    public func project(x: Double, y: Double) -> (x: Double, y: Double) {
        (12+(x-xMin)/(xMax-xMin)*82, 72-(y-yMin)/(yMax-yMin)*64)
    }
    public var usesPointKey: Bool {
        points.enumerated().contains { index, p in
            p.label.count > 18 || points.enumerated().contains { otherIndex, other in
                let a = project(x:p.x,y:p.y), b = project(x:other.x,y:other.y)
                return index != otherIndex && hypot(a.x-b.x,a.y-b.y)<7
            }
        }
    }
    public func pointLabel(index: Int) -> String { usesPointKey ? String(UnicodeScalar(65+index)!):points[index].label }
    public var pointKey: [String] { usesPointKey ? points.enumerated().map { "\(pointLabel(index:$0.offset)): \($0.element.label)" }:[] }
    public var height: Double { 84+Double(pointKey.count)*4 }
    public func labelPosition(index: Int) -> (x:Double,y:Double,alignLeft:Bool) {
        let p = project(x:points[index].x,y:points[index].y)
        let nearby = points.prefix(index).filter { other in
            let b = project(x:other.x,y:other.y)
            return hypot(p.x-b.x,p.y-b.y)<7
        }.count
        let alignLeft = nearby%4 >= 2 || p.x > 75
        return (p.x+(alignLeft ? -2:2),p.y+(nearby%2 == 1 || p.y < 17 ? 5:-3),alignLeft)
    }
    public func ticks(min: Double, max: Double) -> [Double] {
        let rough = (max-min)/8, magnitude = pow(10,floor(log10((max-min)/8)))
        let step = [1.0,2,5,10].map { $0*magnitude }.first { $0 >= rough } ?? 10*magnitude
        return stride(from: ceil(min/step)*step, through: max+step*0.001, by: step).map { ($0*100000).rounded()/100000 }
    }
    public func segments(_ curve: Curve) -> [[(x: Double,y: Double)]] {
        func y(_ x: Double) -> Double { curve.a*x*x+curve.b*x+curve.c }
        var breaks = [xMin,xMax]
        for edge in [yMin,yMax] {
            if curve.a == 0 { if curve.b != 0 { breaks.append((edge-curve.c)/curve.b) } }
            else {
                let d = curve.b*curve.b-4*curve.a*(curve.c-edge)
                if d >= 0 { for sign in [-1.0,1] { breaks.append((-curve.b+sign*sqrt(d))/(2*curve.a)) } }
            }
        }
        breaks = Array(Set(breaks.filter { $0 >= xMin && $0 <= xMax })).sorted()
        var result: [[(x:Double,y:Double)]] = []
        for index in 1..<breaks.count {
            let start = breaks[index-1], end = breaks[index], middle = y((start+end)/2)
            guard middle >= yMin && middle <= yMax else { continue }
            var samples = (0...80).map { start+(end-start)*Double($0)/80 }
            if curve.a != 0 {
                let vertex = -curve.b/(2*curve.a)
                if vertex > start && vertex < end { samples.append(vertex) }
            }
            result.append(samples.sorted().map { project(x:$0,y:y($0)) })
        }
        return result
    }
}
