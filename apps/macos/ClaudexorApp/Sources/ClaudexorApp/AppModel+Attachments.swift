import ClaudexorKit
import Foundation

struct PendingAttachment: Identifiable, Equatable, Sendable {
    let id = UUID()
    let kind: String
    let mime: String
    let name: String
    let data: Data
}

extension AppModel {
    nonisolated static func attachmentInputs(manifest: JSONValue?) -> [HarnessAttachmentInput] {
        guard case .array(let inputs) = manifest?["capability_profile"]?["attachment_inputs"] else {
            return []
        }
        return inputs.compactMap { input in
            guard let kind = input["kind"]?.stringValue,
                  kind == "image" || kind == "file",
                  let maxBytes = input["max_bytes"]?.doubleValue, maxBytes > 0, maxBytes.isFinite,
                  let maxCount = input["max_count"]?.doubleValue, maxCount > 0, maxCount.isFinite,
                  maxBytes.rounded(.towardZero) == maxBytes,
                  maxCount.rounded(.towardZero) == maxCount,
                  maxBytes <= Double(Int.max), maxCount <= Double(Int.max),
                  let transport = input["transport"]?.stringValue, !transport.isEmpty,
                  case .array(let mimeTypes) = input["mime_types"] else {
                return nil
            }
            let mimes = mimeTypes.compactMap(\.stringValue).filter { !$0.isEmpty }
            guard !mimes.isEmpty else { return nil }
            return HarnessAttachmentInput(
                kind: kind,
                mimeTypes: mimes,
                maxBytes: Int(maxBytes),
                maxCount: Int(maxCount),
                transport: transport
            )
        }
    }

    func uploadAttachments(
        _ attachments: [PendingAttachment],
        client: GatewayClient,
        locationID: ExecutionLocationID
    ) async throws -> [ResourceAttachmentRef] {
        var references: [ResourceAttachmentRef] = []
        for attachment in attachments {
            references.append(try await client.uploadResource(
                kind: attachment.kind,
                mime: attachment.mime,
                name: attachment.name,
                data: attachment.data
            ))
            guard isCurrentGateway(client, at: locationID) else { break }
        }
        return references
    }
}
