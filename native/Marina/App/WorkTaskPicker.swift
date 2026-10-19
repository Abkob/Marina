import SwiftUI
import UIKit
import MarinaCore

final class WorkTaskPickerControl: UIControl {
    var context: DayWorkContext? { didSet { if !holding { retainSelection(); render() } } }
    var onChoose: ((DayWorkCommand) -> Void)?
    var onCancel: (() -> Void)?
    private let previous = UILabel(), title = UILabel(), detail = UILabel(), next = UILabel(), hint = UILabel()
    private var selectedID: String?
    private var snapshot: WorkPickerSnapshot?
    private var index = 0, anchor = 0
    private var origin = CGPoint.zero
    private var holding = false, canceled = false
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .secondarySystemBackground; layer.cornerRadius = 18
        previous.font = .preferredFont(forTextStyle: .caption1); next.font = previous.font
        previous.textColor = .tertiaryLabel; next.textColor = .tertiaryLabel
        title.font = .preferredFont(forTextStyle: .headline); title.numberOfLines = 2
        detail.font = .preferredFont(forTextStyle: .caption1); detail.textColor = .secondaryLabel
        hint.font = .preferredFont(forTextStyle: .caption2); hint.textColor = .secondaryLabel; hint.numberOfLines = 2
        for label in [previous,title,detail,next,hint] { label.adjustsFontForContentSizeCategory = true; label.lineBreakMode = .byTruncatingTail }
        let stack = UIStackView(arrangedSubviews: [previous,title,detail,next,hint]); stack.axis = .vertical; stack.spacing = 7; stack.isUserInteractionEnabled = false; stack.translatesAutoresizingMaskIntoConstraints = false; addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),stack.topAnchor.constraint(equalTo: topAnchor, constant: 14),stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),heightAnchor.constraint(greaterThanOrEqualToConstant: 154)])
        let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:))); hold.minimumPressDuration = 0.3; hold.allowableMovement = 10; addGestureRecognizer(hold)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped)); tap.require(toFail: hold); addGestureRecognizer(tap)
        isAccessibilityElement = true; accessibilityTraits = [.button,.adjustable]; accessibilityLabel = "Choose work task"; accessibilityHint = "Adjust to choose a task. Activate to start it. Hold and swipe up or down; release to start. Swipe right to cancel."
        render()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func retainSelection() {
        guard let tasks = context?.tasks, !tasks.isEmpty else { selectedID = nil; index = 0; return }
        index = tasks.firstIndex { $0.id == selectedID } ?? 0; selectedID = tasks[index].id
    }
    private func render() {
        let tasks = holding ? snapshot?.tasks ?? [] : context?.tasks ?? []
        guard tasks.indices.contains(index) else { previous.text = nil; title.text = "Choose today’s tasks below"; detail.text = nil; next.text = nil; hint.text = "Add tasks or link them to today’s calendar"; accessibilityValue = "No tasks"; return }
        previous.text = index > 0 ? tasks[index - 1].title : "Tasks for today"
        title.text = tasks[index].title; detail.text = tasks[index].context
        next.text = index + 1 < tasks.count ? tasks[index + 1].title : nil
        hint.text = holding ? (canceled ? "Release to cancel" : "Release to start · swipe right to cancel") : "Tap to start · hold & swipe to choose"
        accessibilityValue = "\(tasks[index].title), \(tasks[index].context), \(index + 1) of \(tasks.count)"
    }
    @objc private func tapped() {
        guard isEnabled, let context else { return }
        let captured = WorkPickerSnapshot(context: context)
        if let command = captured.command(index: index, at: Date()) { onChoose?(command) }
    }
    @objc private func held(_ gesture: UILongPressGestureRecognizer) {
        guard isEnabled else { return }
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            guard let context, !context.tasks.isEmpty else { return }
            retainSelection(); snapshot = WorkPickerSnapshot(context: context); holding = true; anchor = index; origin = point; canceled = false
            UISelectionFeedbackGenerator().selectionChanged(); render()
        case .changed:
            guard holding, let snapshot else { return }
            canceled = abs(point.x - origin.x) > 90
            if let chosen = snapshot.index(anchor: anchor, translationY: Double(point.y - origin.y)), chosen != index { index = chosen; UISelectionFeedbackGenerator().selectionChanged() }
            render()
        case .ended:
            guard holding else { return }
            let command = canceled ? nil : snapshot?.command(index: index, at: Date())
            selectedID = command?.taskID ?? selectedID
            holding = false; snapshot = nil; retainSelection(); render()
            if let command { onChoose?(command) } else { onCancel?() }
        case .cancelled,.failed:
            holding = false; snapshot = nil; retainSelection(); render(); onCancel?()
        default: break
        }
    }
    override func accessibilityIncrement() { adjust(1) }
    override func accessibilityDecrement() { adjust(-1) }
    private func adjust(_ delta: Int) {
        guard !holding, let tasks = context?.tasks, !tasks.isEmpty else { return }
        index = min(tasks.count - 1,max(0,index + delta)); selectedID = tasks[index].id; render()
    }
    override func accessibilityActivate() -> Bool { tapped(); return true }
}
struct WorkTaskPicker: UIViewRepresentable {
    let context: DayWorkContext?
    let disabled: Bool
    let onChoose: (DayWorkCommand) -> Void
    let onCancel: () -> Void
    func makeUIView(context: Context) -> WorkTaskPickerControl { let view = WorkTaskPickerControl(); view.accessibilityIdentifier = "work-task-picker"; return view }
    func updateUIView(_ view: WorkTaskPickerControl, context: Context) { view.context = self.context; view.isEnabled = !disabled; view.onChoose = onChoose; view.onCancel = onCancel }
}
