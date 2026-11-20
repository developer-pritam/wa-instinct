import WebSocket from "ws"
const ws = new WebSocket("wss://web.whatsapp.com/ws/chat", { origin: "https://web.whatsapp.com", headers: { "User-Agent": "Mozilla/5.0" } })
ws.on("open", () => { console.log("WS OPEN OK"); process.exit(0) })
ws.on("unexpected-response", (req,res) => { console.log("HTTP", res.statusCode, res.headers["x-whatsapp-error"]||""); process.exit(3) })
ws.on("error", (e) => { console.log("WS ERROR code=", e.code, "msg=", JSON.stringify(e.message), "errno=", e.errno, "syscall=", e.syscall, "cause=", e.cause && e.cause.message); process.exit(1) })
setTimeout(()=>{console.log("timeout");process.exit(2)}, 20000)
