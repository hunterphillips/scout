import Foundation
import Testing
@testable import ScoutKit

@Suite struct ResultsModelTests {
    typealias F = ContractFixtures
    static let items = [
        ResultItem(candidateId: "c1", title: "Webhooks", reason: "You read about retries.", hostname: "docs.example.com"),
        ResultItem(candidateId: "c2", title: "Testing", reason: "Covers the CLI.", hostname: "docs.example.com"),
    ]

    /// Running core "core-1", visiting docs.example.com as visit `epoch`.
    private func visiting(epoch: Int = 1) throws -> PanelModel {
        var model = PanelModel(commands: CommandTracker(prefix: "t"))
        _ = model.apply(.running)
        _ = model.apply(.capabilities(try TestFrames.capabilities(instance: "core-1")))
        _ = model.apply(.state(status: .idle, visitEpoch: epoch, detail: "docs.example.com", permitted: true))
        return model
    }

    private func ready(epoch: Int = 1, job: String = "job-1") throws -> PanelModel {
        var model = try visiting(epoch: epoch)
        _ = model.apply(TestFrames.results(epoch: epoch, job: job, .ok(Self.items)))
        return model
    }

    @Test func everyStateIsDistinctAndEmptyIsNeverAFailure() throws {
        var model = try visiting()
        #expect(model.resultsDisplay == .none)
        _ = model.apply(.state(status: .working, visitEpoch: 1, detail: nil, jobId: "job-1"))
        #expect(model.resultsDisplay == .working)
        var seen: [ResultsDisplay] = [.none, .working]
        let outcomes: [ResultsOutcome] = [
            .ok(Self.items), .empty, .unavailable(.noTimeLeft), .error(.timeout), .error(.agentFailed), .cancelled(.superseded),
        ]
        for (i, outcome) in outcomes.enumerated() {
            _ = model.apply(TestFrames.results(epoch: 1, job: "job-\(i + 1)", outcome))
            seen.append(model.resultsDisplay)
        }
        #expect(seen == [.none, .working, .ready(Self.items), .empty, .unavailable(.noTimeLeft), .timeout, .error(.agentFailed), .cancelled(.superseded)])
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        seen.append(model.resultsDisplay)
        _ = model.apply(.state(status: .disconnected, visitEpoch: nil, detail: nil))
        seen.append(model.resultsDisplay)
        #expect(seen.suffix(2) == [.paused, .disconnected])
        // All distinct, each with its own text.
        #expect(Set(seen.map(\.explanation)).count == seen.count)
        let failures: [ResultsDisplay] = [.unavailable(.busy), .timeout, .error(.invalidOutput), .cancelled(.visitChanged), .paused, .disconnected]
        for failure in failures {
            #expect(failure.summary != ResultsDisplay.empty.summary && failure.explanation != ResultsDisplay.empty.explanation)
        }
    }

    @Test func compactLineShowsTheResultsState() throws {
        var model = try ready()
        #expect(model.compactLine == "Idle · docs.example.com · 2 links")
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-2", .empty))
        #expect(model.compactLine == "Idle · docs.example.com · Nothing relevant")
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-3", .error(.timeout)))
        #expect(model.compactLine == "Idle · docs.example.com · Timed out")
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        #expect(model.compactLine == "Paused")
    }

    @Test func ignoresResultsForAnotherCoreInstanceOrVisit() throws {
        var model = try visiting(epoch: 2)
        _ = model.apply(TestFrames.results(epoch: 2, instance: "core-0", .ok(Self.items)))
        #expect(model.results == nil)
        _ = model.apply(TestFrames.results(epoch: 1, .ok(Self.items)))
        #expect(model.results == nil)
        _ = model.apply(TestFrames.results(epoch: 3, .ok(Self.items)))
        #expect(model.results == nil)
        _ = model.apply(TestFrames.results(epoch: 2, .ok(Self.items)))
        #expect(model.resultsDisplay == .ready(Self.items))
    }

    @Test func ignoresResultsBeforeTheCoreNamedItself() throws {
        var model = PanelModel(commands: CommandTracker(prefix: "t"))
        _ = model.apply(.running)
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: "docs.example.com", permitted: true))
        _ = model.apply(TestFrames.results(epoch: 1, .ok(Self.items)))
        #expect(model.results == nil)
    }

    @Test func aNewVisitPauseOrClearResetsTheResults() throws {
        var model = try ready()
        _ = model.apply(.state(status: .idle, visitEpoch: 2, detail: "other.example.org", permitted: true))
        #expect(model.resultsDisplay == .none)
        model = try ready()
        _ = model.apply(.state(status: .paused, visitEpoch: nil, detail: nil))
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: "docs.example.com", permitted: true))
        #expect(model.resultsDisplay == .none)
        // The core cleared them: the same visit's idle state again.
        model = try ready()
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: "docs.example.com", permitted: true))
        #expect(model.resultsDisplay == .none)
        // A core restart.
        model = try ready()
        _ = model.apply(.capabilities(try TestFrames.capabilities(instance: "core-2")))
        #expect(model.results == nil)
    }

    @Test func aLateResultNeverReplacesANewerOne() throws {
        // An older visit's result after the new visit's state.
        var model = try ready(epoch: 1)
        _ = model.apply(.state(status: .idle, visitEpoch: 2, detail: "docs.example.com", permitted: true))
        _ = model.apply(TestFrames.results(epoch: 2, job: "job-2", .empty))
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-1", .ok(Self.items)))
        #expect(model.resultsDisplay == .empty)

        // A replaced job's result while the replacement runs, and after it answered.
        model = try visiting()
        _ = model.apply(.state(status: .working, visitEpoch: 1, detail: nil, jobId: "job-1"))
        _ = model.apply(.state(status: .working, visitEpoch: 1, detail: nil, jobId: "job-2"))
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-1", .ok(Self.items)))
        #expect(model.resultsDisplay == .working)
        _ = model.apply(.state(status: .idle, visitEpoch: 1, detail: "docs.example.com", permitted: true))
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-1", .ok(Self.items)))
        #expect(model.results == nil)
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-2", .empty))
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-1", .ok(Self.items)))
        #expect(model.resultsDisplay == .empty)

        // A result replaced by a newer job's result.
        model = try ready(job: "job-1")
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-2", .error(.agentFailed)))
        _ = model.apply(TestFrames.results(epoch: 1, job: "job-1", .ok(Self.items)))
        #expect(model.resultsDisplay == .error(.agentFailed))
    }

    @Test func resultsNeverOpenExpandOrMoveAnything() throws {
        var model = try visiting()
        _ = model.apply(.capabilities(try TestFrames.capabilities(instance: "core-1", revision: 2, offers: [TestFrames.offer()])))
        let offers = model.currentOffers
        _ = model.apply(TestFrames.results(epoch: 1, .ok(Self.items)))
        #expect(model.takeLinksToOpen().isEmpty)
        #expect(!model.expanded && model.section == .results && model.shownPreview == nil)
        #expect(model.commands.records.isEmpty)
        // A newer result does not displace the site's offers.
        #expect(model.currentOffers == offers && model.indicator == .offers(count: 1, host: "docs.example.com"))
    }

    @Test func aClickSendsTheDisplayedIdentityAndOnlyItsAckOpens() throws {
        var model = try ready(job: "job-7")
        #expect(model.openResult("c9") == nil)
        let sent = model.openResult("c2")
        let click = try #require(sent)
        guard case let .panel(id, request) = click else { Issue.record("not a window command"); return }
        #expect(request == .openLink(coreInstanceId: "core-1", visitEpoch: 1, jobId: "job-7", candidateId: "c2"))
        // A second click while the first is pending sends nothing.
        #expect(model.openResult("c2") == nil)
        #expect(model.linkRecord("c2")?.state == .pending)
        #expect(model.takeLinksToOpen().isEmpty)

        _ = model.apply(.ack(.ok(commandId: id, revision: 0, approvalRevision: 0, target: F.origin + "/testing")))
        #expect(model.takeLinksToOpen() == [LinkOpenRequest(commandId: id, href: F.origin + "/testing", origin: F.origin)])
        // The same ack again opens nothing more.
        _ = model.apply(.ack(.ok(commandId: id, revision: 0, approvalRevision: 0, target: F.origin + "/testing")))
        #expect(model.takeLinksToOpen().isEmpty)
    }

    @Test func aRefusedClickOpensNothingAndIsAProblem() throws {
        var model = try ready()
        let sent = model.openResult("c1")
        let click = try #require(sent)
        _ = model.apply(.ack(.failed(commandId: click.commandId!, code: .staleRevision, revision: nil)))
        #expect(model.takeLinksToOpen().isEmpty)
        guard case let .command(record)? = model.problems.first else { Issue.record("no problem"); return }
        #expect(record.id == click.commandId && record.state == .failed(.staleRevision))
    }

    @Test func aTargetThisAppWouldNotOpenIsAProblem() throws {
        for (target, refusal) in [("https://evil.example/x", LinkOpener.Refusal.wrongHost), ("http://docs.example.com/x", .notHTTPS),
                                  (nil, .malformed)] as [(String?, LinkOpener.Refusal)] {
            var model = try ready()
            let sent = model.openResult("c1")
            let click = try #require(sent)
            _ = model.apply(.ack(.ok(commandId: click.commandId!, revision: 0, approvalRevision: 0, target: target)))
            #expect(model.takeLinksToOpen().isEmpty)
            #expect(model.problems == [.link(commandId: click.commandId!, refusal)])
            model.dismiss(click.commandId!)
            #expect(model.problems.isEmpty)
        }
    }

    @Test func anAckForACommandTheModelDidNotIssueOpensNothing() throws {
        var model = try ready()
        _ = model.apply(.ack(.ok(commandId: "t-99", revision: 0, approvalRevision: 0, target: F.origin + "/x")))
        #expect(model.takeLinksToOpen().isEmpty)
    }

    /// Opens what the model queued the way the app does, recording refusals.
    private func openQueued(_ model: inout PanelModel, with opener: LinkOpener, log: OpenLog) {
        for request in model.takeLinksToOpen() {
            opener.open(request.href, origin: request.origin) { log.answer($0) }
            if case let refusal?? = log.answers.last { model.linkRefused(commandId: request.commandId, refusal) }
        }
    }

    @Test func clicksOpenThroughTheInjectedOpener() throws {
        var model = try ready()
        let log = OpenLog()
        let sent = model.openResult("c1")
        let click = try #require(sent)
        _ = model.apply(.ack(.ok(commandId: click.commandId!, revision: 0, approvalRevision: 0, target: F.origin + "/webhooks")))
        openQueued(&model, with: log.opener(), log: log)
        #expect(log.opened == [URL(string: F.origin + "/webhooks")!])
        #expect(model.problems.isEmpty)
    }

    @Test func aLinkChromeCouldNotOpenIsAProblemWithDismissOnly() throws {
        var model = try ready()
        let log = OpenLog()
        let sent = model.openResult("c1")
        let click = try #require(sent)
        _ = model.apply(.ack(.ok(commandId: click.commandId!, revision: 0, approvalRevision: 0, target: F.origin + "/webhooks")))
        openQueued(&model, with: log.opener(succeeds: false), log: log)
        #expect(model.problems == [.link(commandId: click.commandId!, .openFailed)])
        #expect(!model.canRetry(click.commandId!))
        model.dismiss(click.commandId!)
        #expect(model.problems.isEmpty)
    }

    @Test func aFailedClickIsNeverRetried() throws {
        var model = try ready()
        let sent = model.openResult("c1")
        let click = try #require(sent)
        let id = click.commandId!
        // Unsent: the pipe's own re-send still covers it, but there is no Retry.
        #expect(!model.canRetry(id))
        #expect(model.commands.unsent == [click])
        model.markSent(click, written: true)
        // `unavailable` is a retryable code for decisions; a click still gets Dismiss only.
        _ = model.apply(.ack(.failed(commandId: id, code: .unavailable, revision: nil)))
        guard case let .command(record)? = model.problems.first else { Issue.record("no problem"); return }
        #expect(record.id == id)
        #expect(!model.canRetry(id))
        #expect(model.retry(id) == nil)
        #expect(model.commands.record(id)?.state == .failed(.unavailable))
    }

    @Test func aLateAckAfterNavigatingStillOpensTheClickedLink() throws {
        var model = try ready()
        let sent = model.openResult("c1")
        let click = try #require(sent)
        // The user moves on before the core answers; the results are gone.
        _ = model.apply(.state(status: .idle, visitEpoch: 2, detail: "other.example.org", permitted: true))
        #expect(model.results == nil)
        _ = model.apply(.ack(.ok(commandId: click.commandId!, revision: 0, approvalRevision: 0, target: F.origin + "/webhooks")))
        #expect(model.takeLinksToOpen() == [LinkOpenRequest(commandId: click.commandId!, href: F.origin + "/webhooks", origin: F.origin)])
    }

    @Test func nothingIsClickableWithoutReadyResultsOrARunningCore() throws {
        var model = try visiting()
        #expect(model.openResult("c1") == nil)
        _ = model.apply(TestFrames.results(epoch: 1, .empty))
        #expect(model.openResult("c1") == nil)
        model = try ready()
        _ = model.apply(.stopped)
        #expect(model.openResult("c1") == nil)
    }

    @Test func aPendingClickIsNotResentToARestartedCore() throws {
        var model = try ready()
        let sent = model.openResult("c1")
        let click = try #require(sent)
        model.markSent(click, written: true)
        _ = model.apply(.starting)
        #expect(model.apply(.running).isEmpty)
        #expect(model.commands.record(click.commandId!)?.state == .unknown)
    }
}
