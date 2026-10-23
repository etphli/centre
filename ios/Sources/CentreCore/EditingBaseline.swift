import Foundation

/// The visible payloads an editor loaded. Transport-only acknowledgements may advance
/// versions without changing these payloads; actual remote edits require a reload.
public struct EditingBaseline: Equatable, Sendable {
    public let kind: String
    public let id: String?
    public let resourceId: String?
    public let records: [CloudRecord]

    public init(kind: String, id: String? = nil, resourceId: String? = nil, records: [CloudRecord]) {
        self.kind=kind; self.id=id; self.resourceId=resourceId
        self.records=records.filter {
            $0.kind == kind && (id == nil || $0.id == id) &&
            (resourceId == nil || (!$0.deleted && $0.data?["deletedAt"].string == nil && $0.data?["resourceId"].string == resourceId))
        }.sorted { $0.key < $1.key }
    }
    public func refreshed(_ records: [CloudRecord]) -> EditingBaseline {
        EditingBaseline(kind:kind,id:id,resourceId:resourceId,records:records)
    }
    public func matches(_ records: [CloudRecord]) -> Bool {
        let current=refreshed(records).records
        return current.count == self.records.count && zip(current,self.records).allSatisfy {
            $0.key == $1.key && $0.schemaVersion == $1.schemaVersion && $0.deleted == $1.deleted && $0.data == $1.data
        }
    }
}
