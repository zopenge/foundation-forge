using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = (
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = "2026-11-12",
      compatibilityFlags = ["no_nodejs_compat", "no_nodejs_compat_v2"],
      globalOutbound = "denied",
      bindings = [(name = "JOURNAL", durableObjectNamespace = "Journal")],
      durableObjectNamespaces = [(className = "Journal", uniqueKey = "artifact-content-consumer-v1", enableSql = true)],
      durableObjectStorage = (localDisk = "data")
    )),
    (name = "data", disk = (path = "data", writable = true)),
    (name = "denied", network = (allow = []))
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")]
);
