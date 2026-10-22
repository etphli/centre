import SwiftUI
import UIKit

/// Centre's quiet palette, mirrored from src/ui/centre.css and preferences.css.
struct CentrePalette: Equatable {
    var bg: Color
    var surface: Color
    var surface2: Color
    var line: Color
    var text: Color
    var text2: Color
    var text3: Color
    var accent: Color
    var accentInk: Color
    var warn: Color
    var danger: Color
    var scheme: ColorScheme

    static let dark = CentrePalette(
        bg: Color(hex: 0x1B1B1A), surface: Color(hex: 0x20201F), surface2: Color(hex: 0x262625),
        line: Color(hex: 0x2D2D2B), text: Color(hex: 0xECEBE7), text2: Color(hex: 0xA8A7A1), text3: Color(hex: 0x8C8B85),
        accent: Color(hex: 0xECEBE7), accentInk: Color(hex: 0x1B1B1A), warn: Color(hex: 0xD6B46A), danger: Color(hex: 0xE08A7E),
        scheme: .dark)

    static let midnight = CentrePalette(
        bg: Color(hex: 0x101114), surface: Color(hex: 0x18191E), surface2: Color(hex: 0x202126),
        line: Color(hex: 0x25272C), text: Color(hex: 0xE8E9EC), text2: Color(hex: 0xA1A3AC), text3: Color(hex: 0x8A8D97),
        accent: Color(hex: 0xE8E9EC), accentInk: Color(hex: 0x101114), warn: Color(hex: 0xD6B46A), danger: Color(hex: 0xE08A7E),
        scheme: .dark)

    static let light = CentrePalette(
        bg: Color(hex: 0xF9F9F7), surface: Color(hex: 0xFFFFFF), surface2: Color(hex: 0xF0EFEC),
        line: Color(hex: 0xE4E4E1), text: Color(hex: 0x131313), text2: Color(hex: 0x383835), text3: Color(hex: 0x6B6964),
        accent: Color(hex: 0x131313), accentInk: Color(hex: 0xF9F9F7), warn: Color(hex: 0x987431), danger: Color(hex: 0xB35449),
        scheme: .light)

    /// `theme` is the synced preferences value: dark, light, midnight or system.
    static func resolve(theme: String?, system: ColorScheme) -> CentrePalette {
        switch theme {
        case "light": return .light
        case "midnight": return .midnight
        case "system": return system == .light ? .light : .dark
        default: return .dark
        }
    }

    /// nil lets iOS decide (theme "system").
    static func preferredScheme(theme: String?) -> ColorScheme? {
        switch theme {
        case "light": return .light
        case "system": return nil
        default: return .dark
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}

private struct CentrePaletteKey: EnvironmentKey {
    static let defaultValue = CentrePalette.dark
}

extension EnvironmentValues {
    var centre: CentrePalette {
        get { self[CentrePaletteKey.self] }
        set { self[CentrePaletteKey.self] = newValue }
    }
}

/// Serif for titles (Iowan Old Style, as on desktop), San Francisco for everything else.
/// Every size is relative to a text style so Dynamic Type scales it.
enum CentreFont {
    static let serifName = "IowanOldStyle-Roman"

    static func serif(_ style: Font.TextStyle) -> Font {
        let size: CGFloat
        switch style {
        case .largeTitle: size = 34
        case .title: size = 28
        case .title2: size = 23
        case .title3: size = 20
        default: size = 17
        }
        return .custom(serifName, size: size, relativeTo: style)
    }

    /// Serif navigation titles, matching the desktop. Colours come from SwiftUI's toolbarBackground.
    @MainActor private static var titleFontsConfigured = false

    @MainActor static func configureTitleFonts() {
        guard !titleFontsConfigured else { return }
        titleFontsConfigured = true
        let large = UIFont(name: serifName, size: 32) ?? UIFont.preferredFont(forTextStyle: .largeTitle)
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: large)]
        let standard = UINavigationBarAppearance()
        standard.configureWithDefaultBackground()
        standard.largeTitleTextAttributes = attributes
        let edge = UINavigationBarAppearance()
        edge.configureWithTransparentBackground()
        edge.largeTitleTextAttributes = attributes
        let bar = UINavigationBar.appearance()
        bar.standardAppearance = standard
        bar.compactAppearance = standard
        bar.scrollEdgeAppearance = edge
    }
}

extension View {
    /// Sets the window tint so UIKit-presented controls (dialogs, menus, date popovers) use Centre's accent, not system blue.
    func centreWindowTint(_ color: Color) -> some View {
        background(WindowTint(color: UIColor(color)).frame(width: 0, height: 0).accessibilityHidden(true))
    }
}

private struct WindowTint: UIViewRepresentable {
    let color: UIColor

    final class Probe: UIView {
        var color: UIColor = .clear { didSet { window?.tintColor = color } }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            window?.tintColor = color
        }
    }

    func makeUIView(context: Context) -> Probe {
        let view = Probe()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: Probe, context: Context) { view.color = color }
}

/// Filled accent action. Minimum 44pt target.
struct CentrePrimaryButtonStyle: ButtonStyle {
    @Environment(\.centre) private var palette
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(palette.accentInk)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity)
            .background(palette.accent.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4),
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

/// Quiet secondary action on the raised surface.
struct CentreQuietButtonStyle: ButtonStyle {
    @Environment(\.centre) private var palette
    @Environment(\.isEnabled) private var isEnabled
    var role: ButtonRole? = nil

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body)
            .foregroundStyle(role == .destructive ? palette.danger : palette.text)
            .opacity(isEnabled ? 1 : 0.45)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity)
            .background(configuration.isPressed ? palette.line : palette.surface2,
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(palette.line))
    }
}

struct CentreLabeledContentStyle: LabeledContentStyle {
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.centre) private var palette

    func makeBody(configuration: Configuration) -> some View {
        let layout = textSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 16))
        layout {
            configuration.label
            if !textSize.isAccessibilitySize { Spacer(minLength: 12) }
            configuration.content.foregroundStyle(palette.text2)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

extension View {
    /// Native grouped list on Centre's background with Centre surfaces.
    func centreList(_ palette: CentrePalette) -> some View {
        self.listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(palette.bg)
    }

    func centreRow(_ palette: CentrePalette) -> some View {
        listRowBackground(palette.surface)
    }
}
