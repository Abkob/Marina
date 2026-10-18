import UIKit
import UserNotifications
import UserNotificationsUI
import MarinaCore

final class NotificationViewController: UIViewController, UNNotificationContentExtension {
    private var target: CheckInTarget?
    private let heading = UILabel(), status = UILabel(), control = HoldTimeControl(), picker = UIDatePicker(), save = UIButton(type: .system)
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .systemBackground
        heading.font = .preferredFont(forTextStyle: .headline); heading.numberOfLines = 2
        status.font = .preferredFont(forTextStyle: .caption1); status.textColor = .secondaryLabel; status.numberOfLines = 0
        picker.datePickerMode = .dateAndTime; picker.preferredDatePickerStyle = .wheels; picker.maximumDate = Date(); picker.isHidden = true
        save.setImage(UIImage(systemName: "checkmark"), for: .normal); save.accessibilityLabel = "Save actual time"; save.isHidden = true
        save.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true; save.addTarget(self, action: #selector(saveExact), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [heading, control, picker, save, status]); stack.axis = .vertical; stack.spacing = 12; stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16), stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16), stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -16)])
        control.onChoose = { [weak self] in self?.submit($0) }
        control.onTap = { [weak self] in guard let self else { return }; self.picker.isHidden = false; self.save.isHidden = false; self.picker.date = self.control.instant; self.preferredContentSize.height = 390 }
        preferredContentSize = CGSize(width: 340, height: 180)
    }
    func didReceive(_ notification: UNNotification) {
        loadViewIfNeeded()
        guard let encoded = notification.request.content.userInfo["target"] as? String, let data = Data(base64Encoded: encoded), let value = try? JSONDecoder().decode(CheckInTarget.self, from: data) else { status.text = "Open Marina to choose this activity."; control.isEnabled = false; return }
        target = value; heading.text = value.title; control.caption = value.label; control.instant = Date(); control.timezone = TimeZone(identifier: value.timezone) ?? .current; picker.timeZone = control.timezone
        status.text = "Choose the actual time. Other ends stay unconfirmed."
    }
    @objc private func saveExact() { submit(picker.date) }
    private func submit(_ time: Date) {
        guard let target, control.isEnabled else { return }; control.isEnabled = false; save.isEnabled = false; status.text = "Saving…"
        Task {
            do { try await SharedStore.submit(target: target, at: time); status.text = "Saved"; extensionContext?.dismissNotificationContentExtension() }
            catch { status.text = error.localizedDescription; control.isEnabled = true; save.isEnabled = true }
        }
    }
}
