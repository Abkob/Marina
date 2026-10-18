import UIKit

/// Used in both the native app and expanded notification. System Home Screen
/// widgets use App Intent buttons; they do not receive arbitrary drag gestures.
final class HoldTimeControl: UIControl {
    var onChoose: ((Date) -> Void)?
    var onTap: (() -> Void)?
    var instant = Date() { didSet { update() } }
    var timezone = TimeZone.current { didSet { update() } }
    var caption = "Started" { didSet { titleLabel.text = caption; accessibilityLabel = "Actual \(caption.lowercased())" } }
    private let titleLabel = UILabel(), clockLabel = UILabel(), hintLabel = UILabel()
    private var anchor = Date(), origin = CGPoint.zero, canceled = false
    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 14; backgroundColor = .secondarySystemBackground
        titleLabel.font = .preferredFont(forTextStyle: .subheadline)
        clockLabel.font = .monospacedDigitSystemFont(ofSize: 26, weight: .medium)
        hintLabel.font = .preferredFont(forTextStyle: .caption2); hintLabel.textColor = .secondaryLabel
        for label in [titleLabel, clockLabel, hintLabel] { label.adjustsFontForContentSizeCategory = true }
        let left = UIStackView(arrangedSubviews: [titleLabel, hintLabel]); left.axis = .vertical; left.spacing = 4
        let row = UIStackView(arrangedSubviews: [left, clockLabel]); row.alignment = .center; row.spacing = 12
        row.isUserInteractionEnabled = false; row.translatesAutoresizingMaskIntoConstraints = false; addSubview(row)
        NSLayoutConstraint.activate([row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14), row.topAnchor.constraint(equalTo: topAnchor, constant: 12), row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12), heightAnchor.constraint(greaterThanOrEqualToConstant: 64)])
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:))); hold.minimumPressDuration = 0.35; hold.allowableMovement = 10; addGestureRecognizer(hold)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped)); tap.require(toFail: hold); addGestureRecognizer(tap)
        isAccessibilityElement = true; accessibilityTraits = [.button, .adjustable]; update()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func update() {
        let formatter = DateFormatter(); formatter.timeZone = timezone; formatter.timeStyle = .short
        clockLabel.text = formatter.string(from: instant); accessibilityValue = clockLabel.text
        hintLabel.text = "Hold & slide · tap for exact time"
    }
    @objc private func tapped() { guard isEnabled else { return }; onTap?() }
    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard isEnabled else { return }
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began: anchor = instant; origin = point; canceled = false; UISelectionFeedbackGenerator().selectionChanged()
        case .changed:
            canceled = point.y - origin.y > 60
            let minutes = (Double(point.x - origin.x) * 180 / max(1, Double(bounds.width)) / 5).rounded() * 5
            instant = min(Date(), anchor.addingTimeInterval(minutes * 60))
            hintLabel.text = canceled ? "Release to cancel" : "Release to save · drag down to cancel"
        case .ended:
            if !canceled { onChoose?(instant) } else { instant = anchor }
            update()
        case .cancelled, .failed: instant = anchor; update()
        default: break
        }
    }
    override func accessibilityIncrement() { instant = min(Date(), instant.addingTimeInterval(300)) }
    override func accessibilityDecrement() { instant = instant.addingTimeInterval(-300) }
    override func accessibilityActivate() -> Bool { onTap?(); return true }
}
