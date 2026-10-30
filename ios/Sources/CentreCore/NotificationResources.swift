import Foundation

public struct AssignmentNotificationContext: Equatable, Sendable {
    public let resourceId: String
    public let title: String
    public let fileName: String
    public let untrustedContent: String
}

/// Reads the portable notification metadata on cached note resources.
public enum NotificationResources {
    public static func isNotification(_ record: CloudRecord) -> Bool {
        guard record.kind == "resource", RecordProjections.visible(record),
              let itemId = record.data?["notification"]["itemId"].string else { return false }
        return !itemId.isEmpty
    }

    public static func linked(toAssignment itemId: String, in records: [CloudRecord]) -> [CloudRecord] {
        guard !itemId.isEmpty else { return [] }
        return records.filter {
            isNotification($0) && $0.data?["notification"]["itemId"].string == itemId
        }.sorted {
            ($0.data?["updatedAt"].string ?? "") > ($1.data?["updatedAt"].string ?? "")
        }
    }

    public static func assignmentContext(text: String, assignments: [JSONValue], resources: [CloudRecord], subjects: [JSONValue] = [], subjectId: String? = nil, resourceId: String? = nil) -> AssignmentNotificationContext? {
        let lowered = text.lowercased()
        let candidates = assignments.compactMap { assignment -> (String, String)? in
            let id = assignment["id"].string ?? "", title = assignment["title"].string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !id.isEmpty, title.count >= 3,
                  subjectId == nil || assignment["subjectId"].string == subjectId,
                  (subjects.contains { subject in
                      subject["id"].string == assignment["subjectId"].string && [subject["name"].string,subject["shortName"].string].compactMap { $0 }.contains { !$0.isEmpty && lowered.contains($0.lowercased()) }
                  } || lowered.contains(title.lowercased()) || title.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).contains { word in
                      word.count > 3 && !["assignment","assessment","notification","checkpoint","worksheet","year","test","exam","task"].contains(word) && lowered.components(separatedBy: CharacterSet.alphanumerics.inverted).contains(word)
                  }) else { return nil }
            return (id, title)
        }.sorted { $0.1.count > $1.1.count }
        for (itemId, _) in candidates {
            let matches = linked(toAssignment: itemId, in: resources)
            let resource = matches.first(where: { $0.id == resourceId }) ?? matches.first
            guard let resource, let data = resource.data else { continue }
            return AssignmentNotificationContext(resourceId: resource.id,
                title: data["title"].string ?? "Assignment notification",
                fileName: data["notification"]["fileName"].string ?? "Attached file",
                untrustedContent: data["content"].string ?? "")
        }
        return nil
    }

}
