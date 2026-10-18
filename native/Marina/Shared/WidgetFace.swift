import SwiftUI
import MarinaCore

struct WidgetFace<Action: View>: View {
    let title: String
    let subtitle: String
    let symbol: String
    let action: Action
    init(title: String, subtitle: String, symbol: String, @ViewBuilder action: () -> Action) { self.title = title; self.subtitle = subtitle; self.symbol = symbol; self.action = action() }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Image(systemName: "circle.hexagongrid").font(.caption).foregroundStyle(.secondary); Spacer() }
            Spacer(minLength: 0)
            Text(title).font(.subheadline.weight(.medium)).lineLimit(2).minimumScaleFactor(0.85).privacySensitive()
            Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            HStack { Spacer(); action }
        }
        .accessibilityElement(children: .contain)
    }
}
struct WidgetGallery: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Layout preview · sample data").font(.caption).foregroundStyle(.secondary)
            ForEach(["Start reading", "End unconfirmed", "Overlapping events", "Connect Marina", "Save needs retry"], id: \.self) { state in
                WidgetFace(title: state == "Connect Marina" ? "Marina" : "Read chapter 4", subtitle: state, symbol: "play") {
                    Image(systemName: state == "End unconfirmed" ? "stop" : "arrow.up.right").frame(width: 44, height: 44).background(.quaternary, in: Circle())
                }.padding(16).frame(width: 170, height: 170).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22)).accessibilityIdentifier("widget-preview-\(state)")
            }
        }
    }
}
