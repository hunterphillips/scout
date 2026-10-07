# Pi job adapter

The Pi adapter runs one `pi --mode json` process per Scout job. It uses a private `PI_CODING_AGENT_DIR` inside the job directory, with a link to the user's private `auth.json` and a small copy of model selection settings. Pi's own provider and model choice apply unless the profile names `provider/model`.

The job exposes only Scout's MCP tools, the selected tool bridge when configured, and `scout_answer`. The bundled `answerExtension.mjs` reads the job's JSON Schema and registers `scout_answer`; its result includes the number of Scout tools Pi loaded so the monitor can detect a missing MCP server. The monitor accepts the first successful answer, rejects unexpected tools, and treats `agent_settled` as the end of the stream.

Readiness starts a disposable Pi agent directory and runs only `--version` and `--list-models`. The adapter uses no model calls during readiness. Tests use `testing/fake-pi.mjs` and the Scout fixture backend.
