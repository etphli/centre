import XCTest
@testable import CentreCore

final class PaperGraphTests: XCTestCase {
    private func value() throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self,from:Data(#"{"xMin":-3,"xMax":7,"yMin":-12,"yMax":10,"curves":[{"a":1,"b":-2,"c":-8,"label":"f"}],"points":[{"x":1,"y":-9,"label":"V"}]}"#.utf8))
    }
    func testPortableGraphAndClipping() throws {
        let graph = try XCTUnwrap(PaperGraph.parse(value()))
        let vertex = graph.project(x:1,y:-9)
        let segments = graph.segments(graph.curves[0])
        XCTAssertTrue(segments.flatMap { $0 }.contains { abs($0.x-vertex.x)<0.00001 && abs($0.y-vertex.y)<0.00001 })
        for point in segments.flatMap({ $0 }) {
            XCTAssertTrue((12...94).contains(point.x))
            XCTAssertTrue(point.y >= 8-0.00001 && point.y <= 72+0.00001)
        }
        XCTAssertLessThanOrEqual(graph.ticks(min:graph.xMin,max:graph.xMax).count,10)
        XCTAssertEqual(try value().decode(PaperGraph.self),graph)
    }
    func testBlankGraphsAndInvalidBounds() throws {
        var data = try value()
        data["curves"] = .array([]); data["points"] = .array([])
        XCTAssertNotNil(PaperGraph.parse(data))
        data["xMin"] = .number(2)
        XCTAssertNil(PaperGraph.parse(data))
        data = try value(); data["xMax"] = .number(10001)
        XCTAssertNil(PaperGraph.parse(data))
        XCTAssertNil(PaperGraph.parse(.null))
    }
    func testCrowdedPointsUseKeysAndSeparateLabels() throws {
        var data = try value()
        data["points"] = .array([
            .object(["x":.number(0),"y":.number(0),"label":.string("exact intercept near zero")]),
            .object(["x":.number(0.1),"y":.number(0),"label":.string("second intercept")])
        ])
        let graph = try XCTUnwrap(PaperGraph.parse(data))
        XCTAssertEqual(graph.pointKey,["A: exact intercept near zero","B: second intercept"])
        XCTAssertEqual(graph.pointLabel(index:0),"A")
        XCTAssertNotEqual(graph.labelPosition(index:0).y,graph.labelPosition(index:1).y)
    }
}
