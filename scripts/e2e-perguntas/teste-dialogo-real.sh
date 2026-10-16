#!/bin/bash
# Tela de seleção desconhecida (seletor do /model) num Claude real: aparece em agent.dialog e Esc pela rota /keys fecha.
T=agente-teste-dialogo; H="${HB_URL:-http://127.0.0.1:4747}"
tmux kill-session -t $T 2>/dev/null
cd ~ && tmux new-session -d -s $T -x 200 -y 50 "claude 'TESTE AUTOMATICO: responda apenas OK.'"
for i in $(seq 1 30); do sleep 2; tmux capture-pane -p -t $T | grep -q "^● OK" && break; done
sleep 2; tmux send-keys -t $T -l -- "/model"; sleep 1; tmux send-keys -t $T Enter
D=""; for i in $(seq 1 20); do sleep 2
  D=$(curl -s $H/api/snapshot | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).agents.find(a=>a.dialog);if(a)console.log(JSON.stringify({id:a.id,status:a.status,waitingFor:a.waitingFor,text:a.dialog.text}))})')
  [ -n "$D" ] && break; done
[ -z "$D" ] && { echo "FALHA: dialogo nao apareceu"; tmux capture-pane -p -t $T | grep -v '^\s*$' | tail -15; tmux kill-session -t $T; exit 1; }
echo "DIALOGO NO HABBLAUD:"; echo "$D" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("status",j.status,"·",j.waitingFor);console.log(j.text)})'
ID=$(echo "$D" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(encodeURIComponent(JSON.parse(s).id)))')
echo "ESC pela rota /keys:"; curl -s -X POST -H "Content-Type: application/json" "$H/api/agents/$ID/keys" -d '{"key":"Escape"}'; echo
sleep 4
LEFT=$(curl -s $H/api/snapshot | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).agents.filter(a=>a.dialog).length))')
tmux capture-pane -p -t $T | grep -v '^\s*$' | tail -4
[ "$LEFT" = 0 ] && echo "RESULTADO: OK" || echo "RESULTADO: FALHA (dialogo continua: $LEFT)"
tmux kill-session -t $T
