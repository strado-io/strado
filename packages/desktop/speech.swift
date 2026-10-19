// strado-speech: on-device speech recognition for "talk to Strado"
// (spec: docs/specs/2026-10-17-strado-voice-design.md). A long-lived helper
// the Electron main process spawns on first use.
//
// Protocol — one JSON object per line.
//   stdin:  {"cmd":"start","contextual":["shell-1","FD-00029_hotfix"],"locale":"en-US"}
//           {"cmd":"stop"}    finish the utterance → a final event
//           {"cmd":"cancel"}  drop it, no final
//   stdout: {"type":"ready"} once at launch
//           {"type":"partial","text":"…"} {"type":"final","text":"…"}
//           {"type":"level","rms":0.0-1.0}  (≤ ~15/s while listening)
//           {"type":"error","code":"…","message":"…"}
//
// Audio never leaves the machine: requiresOnDeviceRecognition is mandatory,
// and a recognizer that can't do it on-device reports `no_on_device` instead
// of silently falling back to Apple's servers. Nothing is written to disk.

import AVFoundation
import Foundation
import Speech

// Be our own "responsible process". macOS asks the app that launched us for
// the speech/mic usage strings — Strado.app, or whatever terminal a dev build
// runs in — and kills us (SIGABRT, namespace TCC) when that app lacks one.
// Re-exec once with responsibility disclaimed so TCC reads OUR embedded
// Info.plist instead. stdio is inherited; we just relay the exit status.
var speechChild: pid_t = 0
func disclaimResponsibility() {
  let env = "STRADO_SPEECH_DISCLAIMED"
  guard getenv(env) == nil,
        let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else { return }
  typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  let setDisclaim = unsafeBitCast(sym, to: SetDisclaim.self)
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  defer { posix_spawnattr_destroy(&attr) }
  guard setDisclaim(&attr, 1) == 0 else { return }
  setenv(env, "1", 1)
  let path = CommandLine.arguments[0]
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, path, nil, &attr, &argv, environ)
  argv.forEach { free($0) }
  guard rc == 0 else { unsetenv(env); return } // fall back to running as-is
  // Closing stdin reaches the child directly (same pipe); a kill is passed on.
  speechChild = pid
  for sig in [SIGTERM, SIGINT, SIGHUP] { signal(sig) { s in kill(speechChild, s); exit(0) } }
  var status: Int32 = 0
  while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
  exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}
disclaimResponsibility()

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

func fail(_ code: String, _ message: String) { emit(["type": "error", "code": code, "message": message]) }

final class Session {
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var recognizer: SFSpeechRecognizer?
  private var lastText = ""
  /** Text from earlier stretches of this utterance. After a pause the
   * recognizer starts a new transcription; what was said before lives here. */
  private var committed = ""
  private var lastEnd: TimeInterval = 0 // where the last transcription's words end in the audio
  private var stopping = false
  private var finished = false
  private var contextual: [String] = []
  private var lastLevelAt = Date.distantPast

  var active: Bool { task != nil }

  func start(contextual: [String], locale: String) {
    cancel()
    guard let rec = SFSpeechRecognizer(locale: Locale(identifier: locale)), rec.isAvailable else {
      return fail("unavailable", "speech recognition is not available for \(locale)")
    }
    guard rec.supportsOnDeviceRecognition else {
      return fail("no_on_device", "on-device recognition is not available for \(locale); enable it in System Settings → Keyboard → Dictation")
    }
    recognizer = rec
    self.contextual = Array(contextual.prefix(100))
    lastText = ""
    committed = ""
    stopping = false
    finished = false

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
      self?.meter(buffer)
    }
    begin(rec)
    engine.prepare()
    do { try engine.start() } catch {
      input.removeTap(onBus: 0)
      task?.cancel()
      request = nil
      task = nil
      return fail("mic_failed", "could not start the microphone: \(error.localizedDescription)")
    }
  }

  /** One recognition task. A pause can end it while the key is still held:
   * then its words are kept and a new one carries on. */
  private func begin(_ rec: SFSpeechRecognizer) {
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.requiresOnDeviceRecognition = true
    req.shouldReportPartialResults = true
    req.taskHint = .dictation
    req.contextualStrings = contextual
    request = req
    lastEnd = 0
    task = rec.recognitionTask(with: req) { [weak self] result, error in
      guard let self, self.request === req else { return }
      if let result {
        let text = result.bestTranscription.formattedString
        let segs = result.bestTranscription.segments
        let start = segs.first?.timestamp ?? 0
        // A transcription that begins after the last one ended, or shrinks to
        // something that starts differently, is a new stretch after a pause:
        // keep the old words.
        if !self.lastText.isEmpty && !text.isEmpty && Session.restarted(from: self.lastText, endingAt: self.lastEnd, to: text, startingAt: start) {
          self.committed = Session.join(self.committed, self.lastText)
        }
        self.lastEnd = segs.last.map { $0.timestamp + $0.duration } ?? 0
        self.lastText = text
        let full = Session.join(self.committed, text)
        if result.isFinal {
          if self.stopping { return self.finish(full) }
          // Ended mid-utterance (the key is still held): keep listening.
          self.committed = full
          self.lastText = ""
          self.begin(rec)
          return
        }
        emit(["type": "partial", "text": full])
      } else if let error {
        // Ending the audio with nothing said surfaces as an error: report an
        // empty final rather than a failure, so the box simply does nothing.
        if self.request == nil || self.finished { return }
        let ns = error as NSError
        if ns.domain == "kAFAssistantErrorDomain" && (ns.code == 1110 || ns.code == 216) {
          if self.stopping { self.finish(self.current) } else { self.committed = self.current; self.lastText = ""; self.begin(rec) }
          return
        }
        fail("recognition", error.localizedDescription)
        self.teardown()
      }
    }
  }

  private var current: String { Session.join(committed, lastText) }

  static func join(_ a: String, _ b: String) -> String {
    a.isEmpty ? b : b.isEmpty ? a : "\(a) \(b)"
  }

  static func restarted(from old: String, endingAt oldEnd: TimeInterval, to new: String, startingAt newStart: TimeInterval) -> Bool {
    if oldEnd > 0 && newStart >= oldEnd - 0.05 { return true }
    let firstWord = { (s: String) in s.split(separator: " ").first.map { $0.lowercased() } ?? "" }
    return new.count < old.count / 2 && firstWord(new) != firstWord(old)
  }

  /** Stop listening; the recognizer delivers a final result shortly. */
  func stop() {
    guard request != nil else { return }
    stopping = true
    stopAudio()
    request?.endAudio()
    // Safety net: never leave the box waiting if no final arrives.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
      guard let self, !self.finished, self.task != nil else { return }
      self.finish(self.current)
    }
  }

  func cancel() {
    task?.cancel()
    teardown()
  }

  private func finish(_ text: String) {
    guard !finished else { return }
    finished = true
    emit(["type": "final", "text": text])
    teardown()
  }

  private func stopAudio() {
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
  }

  private func teardown() {
    stopAudio()
    request = nil
    task = nil
  }

  private func meter(_ buffer: AVAudioPCMBuffer) {
    let now = Date()
    guard now.timeIntervalSince(lastLevelAt) > 0.066, let ch = buffer.floatChannelData?[0] else { return }
    lastLevelAt = now
    let n = Int(buffer.frameLength)
    guard n > 0 else { return }
    var sum: Float = 0
    for i in 0..<n { sum += ch[i] * ch[i] }
    let rms = min(1, sqrt(sum / Float(n)) * 8)
    DispatchQueue.main.async { emit(["type": "level", "rms": Double(rms)]) }
  }
}

let session = Session()

func authorize(_ then: @escaping () -> Void) {
  SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
      guard status == .authorized else {
        return fail("speech_denied", "speech recognition permission was not granted")
      }
      AVCaptureDevice.requestAccess(for: .audio) { ok in
        DispatchQueue.main.async {
          if ok { then() } else { fail("mic_denied", "microphone permission was not granted") }
        }
      }
    }
  }
}

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cmd = obj["cmd"] as? String else { return fail("bad_command", "unreadable command") }
  switch cmd {
  case "start":
    let contextual = (obj["contextual"] as? [String]) ?? []
    let locale = (obj["locale"] as? String) ?? Locale.current.identifier
    authorize { session.start(contextual: contextual, locale: locale) }
  case "stop":
    session.stop()
  case "cancel":
    session.cancel()
  default: fail("bad_command", "unknown command \(cmd)")
  }
}

// stdin on a background thread; all work hops to the main queue.
Thread {
  while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    DispatchQueue.main.async { handle(trimmed) }
  }
  // Parent closed stdin (Strado quit): exit after the commands already queued.
  DispatchQueue.main.async { exit(0) }
}.start()

emit(["type": "ready"])
RunLoop.main.run()
