import json,sys
port, cmdlog, here, permtimeout = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
http_events = ["PreToolUse","PostToolUse","PostToolUseFailure","PermissionRequest","PermissionDenied","Stop","StopFailure","MessageDisplay","UserPromptSubmit","Notification","SessionEnd","SubagentStart","SubagentStop","SessionStart"]
cmd_events = ["SessionStart","SessionEnd","UserPromptSubmit","PreToolUse","PostToolUse","PermissionRequest","Stop","PermissionDenied"]
hooks = {}
for e in sorted(set(http_events+cmd_events)):
    hs=[]
    if e in http_events:
        h={"type":"http","url":f"http://127.0.0.1:{port}/{e}","headers":{"X-Ccd-Probe":"1"}}
        if e=="PermissionRequest": h["timeout"]=permtimeout
        hs.append(h)
    if e in cmd_events:
        hs.append({"type":"command","command":f"CMDLOG={cmdlog} node {here}/cmdlog.mjs {e}"})
    hooks[e]=[{"matcher":"*","hooks":hs}]
print(json.dumps({"hooks":hooks},indent=1))
