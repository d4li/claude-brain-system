# Brain System for Claude Code

Sistema de orquestração multi-terminal para Claude Code - gerencia múltiplas instâncias trabalhando em paralelo em diferentes camadas do projeto.

## Arquitetura

### Componentes

- **Brain Core**: Módulo central que coordena todas as atividades
- **Protocol**: Sistema de comunicação baseado em arquivos (IPC)
- **State Manager**: Persistência de estado distribuído
- **Task Manager**: Gerenciamento de tarefas distribuídas
- **Logger**: Logging distribuído para debug

### Estrutura de Diretórios

```
.claude-brain/
├── bin/claude-brain          # CLI executable
├── lib/brain/                # Core modules
│   ├── core.js              # Brain Core
│   ├── protocol.js          # File-based IPC
│   ├── state-manager.js     # State persistence
│   ├── task-manager.js      # Task management
│   ├── logger.js            # Logging system
│   ├── locks.js             # Concurrency control
│   └── index.js            # Module exports
├── state/                   # State storage (JSON files)
├── sessions/               # Session data
├── tasks/                  # Task definitions
├── memory/                 # Context memory (global & terminal-specific)
├── channels/              # Communication channels (IPC)
├── logs/                  # Log files
├── prompts/               # Terminal specialized prompts
├── examples/              # Usage examples
└── package.json           # Dependencies
```

## Instalação

```bash
# Dentro do projeto
cd .claude-brain
npm install

# Adicionar ao PATH (opcional)
export PATH="$PWD/bin:$PATH"
```

## Uso Básico

### Iniciar o Brain Daemon

```bash
# Iniciar em foreground
claude-brain daemon start

# Iniciar em background
claude-brain daemon start --detach

# Ver status
claude-brain daemon status

# Parar daemon
claude-brain daemon stop
```

### Gerenciar Tarefas

```bash
# Listar tarefas
claude-brain task list

# Filtrar por status
claude-brain task list --status pending
claude-brain task list --status in_progress

# Filtrar por área
claude-brain task list --area frontend
claude-brain task list --area backend

# Criar tarefa
claude-brain task create "Implementar componente de login" \
  --area frontend \
  --priority 4 \
  --description "Criar componente de autenticação com formulário de login"

# Ver detalhes da tarefa
claude-brain task get TASK_ID

# Atualizar tarefa
claude-brain task update TASK_ID --status completed
claude-brain task update TASK_ID --owner terminal-2-frontend
```

### Gerenciar Terminais

```bash
# Listar terminais
claude-brain terminal list

# Ver status de um terminal
claude-brain terminal status terminal-1-ux
```

### Estado Global

```bash
# Ver estado
claude-brain state get project.current-phase

# Definir estado
claude-brain state set project.current-phase "development"
```

## Protocolo de Comunicação

### Mensagens

Formato das mensagens no IPC:

```json
{
  "id": "msg-uuid",
  "from": "terminal-1-ux",
  "to": "brain-or-terminal-2",
  "type": "task.update | state.sync | broadcast.message",
  "payload": { /* data */ },
  "timestamp": 1712564400000,
  "priority": 3
}
```

### Tipos de Mensagens

- `terminal.register` - Registro de novo terminal
- `terminal.heartbeat` - Heartbeat dos terminais
- `task.create` - Criação de tarefa
- `task.update` - Atualização de tarefa
- `state.sync` - Sincronização de estado
- `broadcast.message` - Mensagem broadcast

## Exemplos de Fluxo de Trabalho

### Exemplo 1: Ciclo de Desenvolvimento

```bash
# Terminal UX cria design task
Terminal UX> claude-brain task create "Design login flow" --area ux --priority 5

# Terminal Frontend assign para si
Terminal Frontend> claude-brain task assign TASK_ID --owner terminal-2-frontend

# Terminal Frontend atualiza status
Terminal Frontend> claude-brain task update TASK_ID --status in_progress

# Terminal Frontend completa
Terminal Frontend> claude-brain task update TASK_ID --status completed

# Terminal Backend é notificado (via protocol)
# Terminal Backend cria API task
Terminal Backend> claude-brain task create "Create login API" --area backend
```

### Exemplo 2: Comunicação Direta

```javascript
// Enviar mensagem via Protocol
await brain.protocol.send('terminal-2-frontend', 'component.ready', {
  component: 'login-form',
  files: ['src/components/LoginForm.jsx']
});

// Broadcast para todos
await brain.protocol.broadcast('phase.started', {
  phase: 'development',
  message: 'Sprint 3 started'
});
```

## Configuração

### Config.json

Criar `.claude-brain/config.json`:

```json
{
  "heartbeatInterval": 5000,
  "heartbeatTimeout": 15000,
  "sessionTimeout": 300000,
  "stateSaveInterval": 5000
}
```

### Prompts Especializados

Criar prompts específicos para cada tipo de terminal:

**`.claude-brain/prompts/ux-designer.md`:**
```markdown
Você é um UX Designer especializado. Seu foco é:
- User flows e wireframes
- Prototipagem interativa
- Design systems
- User research insights

Trabalhe em colaboração com Frontend e QA.
```

**`.claude-brain/prompts/frontend-engineer.md`:**
```markdown
Você é um Frontend Engineer. Seu foco é:
- Implementação de componentes React/Next.js
- State management
- Performance optimization
- Testes unitários

Receba especificações do UX e integre com APIs do Backend.
```

## Debug

### Ver logs

```bash
# Brain log
tail -f .claude-brain/logs/brain.log

# Log específico do terminal
tail -f .claude-brain/logs/terminal-1-ux.log
```

### Ver estado atual

```bash
# Ver todos os terminais ativos
ls .claude-brain/state/ | grep terminal

# Ver tasks
ls .claude-brain/tasks/

# Ver channels ativos
ls .claude-brain/channels/
```

## API Programática

```javascript
const { BrainCore, TaskManager } = require('./lib/brain');

// Inicializar
const brain = new BrainCore();
await brain.start();

// Criar task
const taskManager = new TaskManager({
  stateManager: brain.stateManager,
  protocol: brain.protocol
});

const task = await taskManager.create({
  subject: 'Task example',
  area: 'frontend',
  priority: 3
});

// Listar tasks
const tasks = await taskManager.list({ status: 'pending' });

// Parar
await brain.stop();
```

## Próximos Passos

- [ ] Implementar WebSocket protocol (performance)
- [ ] Criar interface web dashboard
- [ ] Adicionar hooks pré/post execução
- [ ] Implementar sistema de plugins
- [ ] Adicionar analytics e métricas

## Contribuição

O Brain System é parte da metodologia Vibe Coding. Para contribuir:

1. Crie issues para bugs/features
2. Submeta pull requests
3. Siga o código de conduta
4. Escreva testes para novas funcionalidades

## Licença

MIT License
