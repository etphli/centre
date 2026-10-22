import Foundation
import Security
import CentreCore

struct SavedSession: Codable {
    let baseURL:String
    let session:CloudSession
    let cloudAIAllowed:Bool?
    init(baseURL:String,session:CloudSession,cloudAIAllowed:Bool?=nil) { self.baseURL=baseURL;self.session=session;self.cloudAIAllowed=cloudAIAllowed }
}
enum SessionVault {
    private static var query: [String: Any] { [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"Centre Cloud",kSecAttrAccount as String:"session"] }
    static func read() throws -> SavedSession? {
        var request=query;request[kSecReturnData as String]=true;request[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?
        let status=SecItemCopyMatching(request as CFDictionary,&result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,let bytes=result as? Data else { throw CentreError.storage("Your saved account is locked. Unlock your iPhone and try again.") }
        return try JSONDecoder().decode(SavedSession.self,from:bytes)
    }
    static func save(_ value:SavedSession) throws {
        let data=try JSONEncoder().encode(value)
        let values:[String:Any]=[kSecValueData as String:data,kSecAttrAccessible as String:kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status=SecItemUpdate(query as CFDictionary,values as CFDictionary)
        if status == errSecItemNotFound {
            var item=query;for (key,value) in values { item[key]=value }
            guard SecItemAdd(item as CFDictionary,nil) == errSecSuccess else { throw CentreError.storage("Account access could not be saved in Keychain.") }
        } else if status != errSecSuccess { throw CentreError.storage("Account access could not be updated in Keychain.") }
    }
    static func clear() throws {
        let status=SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CentreError.storage("Account access could not be removed from Keychain.") }
    }
}
