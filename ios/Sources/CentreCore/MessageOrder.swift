import Foundation

public enum CloudMessageOrder {
    /// Older messages keep their tie-group slots; only records with creation sequences exchange slots.
    public static func sorted(_ records: [CloudRecord]) -> [CloudRecord] {
        var result = records.enumerated().sorted { lhs, rhs in
            let a = createdAt(lhs.element), b = createdAt(rhs.element)
            return a == b ? lhs.offset < rhs.offset : a < b
        }.map(\.element)
        var start = 0
        while start < result.count {
            var end = start + 1
            while end < result.count, createdAt(result[end]) == createdAt(result[start]) { end += 1 }
            let known = (start..<end).compactMap { index -> (index: Int, record: CloudRecord, cursor: String)? in
                guard let cursor = decimal(result[index].createdCursor) else { return nil }
                return (index, result[index], cursor)
            }
            let ordered = known.sorted { a, b in
                if a.cursor.count != b.cursor.count { return a.cursor.count < b.cursor.count }
                if a.cursor != b.cursor { return a.cursor < b.cursor }
                return a.index < b.index
            }
            for (slot, message) in zip(known, ordered) { result[slot.index] = message.record }
            start = end
        }
        return result
    }

    private static func createdAt(_ record: CloudRecord) -> String { record.data?["createdAt"].string ?? "" }
    private static func decimal(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        let digits = value.drop(while: { $0 == "0" })
        return digits.isEmpty ? "0" : String(digits)
    }
}
