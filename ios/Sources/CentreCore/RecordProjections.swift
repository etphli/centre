import Foundation

public enum RecordProjections {
    public static func visible(_ record: CloudRecord) -> Bool {
        record.schemaVersion == 1 && !record.deleted && record.data?["deletedAt"].string == nil
    }
    public static func reviewMemories(_ records: [CloudRecord]) -> [CloudRecord] {
        let resources=Set(records.filter { $0.kind == "resource" && visible($0) }.map(\.id))
        return records.filter {
            $0.kind == "reviewMemory" && visible($0) && $0.data?["resolvedAt"].string == nil &&
            $0.data?["resourceId"].string.map(resources.contains) == true
        }.sorted { ($0.data?["nextReviewAt"].string ?? "") < ($1.data?["nextReviewAt"].string ?? "") }
    }
    public static func recoverTimers(_ records: [CloudRecord], excluding: Set<String> = [], now: Date) throws -> [LocalChange] {
        try records.filter { $0.kind == "studySession" && visible($0) && !excluding.contains($0.id) }.compactMap { record in
            guard let data=record.data, data["schemaVersion"].int == 1 else { return nil }
            let value=try data.decode(StudySession.self)
            let recovered=try StudyRules.recover(value,now:now,restart:true)
            return recovered == value ? nil : LocalChange(kind:"studySession",id:record.id,data:try JSONValue.encode(recovered))
        }
    }
    /// Validate local resource edits. Import remains lossless so legacy records can be repaired.
    public static func validateLocation(_ data: JSONValue, topics: [CloudRecord]) throws {
        let subject=data["subjectId"].string, topic=data["topicId"].string
        guard (data["subjectId"] == .null || subject?.isEmpty == false),
              (data["topicId"] == .null || topic?.isEmpty == false) else {
            throw CentreError.invalid("Choose valid subject and topic identifiers, or a personal note.")
        }
        guard (subject == nil) == (topic == nil) else {
            throw CentreError.invalid("Choose both a subject and one of its topics, or choose no subject for a personal note.")
        }
        if let subject, let topic {
            guard topics.contains(where: { $0.id == topic && visible($0) && $0.data?["subjectId"].string == subject }) else {
                throw CentreError.invalid("Choose an available topic belonging to this subject.")
            }
        }
    }
}
