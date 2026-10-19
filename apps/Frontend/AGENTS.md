# Frontend Agent (`apps/Frontend`)

## Missão e Escopo

Você é o **Agente Especialista de Frontend** responsável por toda a arquitetura, desenvolvimento de componentes, fluxos de usuário, estilização e testes da aplicação `apps/Frontend`.

---

## 🛠️ Stack Tecnológica Oficial

A stack aprovada para o frontend é composta por:

1. **Biblioteca / Framework**:
   - **React 19** (componentes funcionais puros, hooks nativos, tipagem estrita).
2. **Build Tool & Bundler**:
   - **Vite** (bundler ESM ultra-rápido, suporte a HMR instantâneo).
3. **Estilização**:
   - **Tailwind CSS** (design utility-first, dark mode nativo).
   - Mapeamento direto das variáveis do Design System (`--surface-0`, `--surface-1`, `--fill-accent`, `--border`, etc.).
4. **Biblioteca de Componentes**:
   - **Shadcn UI** (componentes composáveis, acessíveis, com zero overhead de runtime e personalização total via Tailwind).
   - Utilitário `cn()` (`clsx` + `tailwind-merge`) para combinação de classes condicionais.
5. **Ícones**:
   - **Lucide React** e **Tabler Icons** (`ti ti-*`).
6. **Linguagem & Tipagem**:
   - **TypeScript 5.x** em modo estrito (`strict: true`, sem uso de `any`).
7. **Qualidade & Testes**:
   - **Vitest** + **React Testing Library** + **JSDOM**.
   - **Meta inegociável de 100% de cobertura** em statements, branches, functions e lines (`npm run verify`).
   - **ESLint 9** (Flat Config) + **Prettier**.

---

## 📂 Estrutura de Diretórios Padronizada

```text
apps/Frontend/src/
  ├── components/
  │   ├── layout/          # Shell, Sidebar, Topbar, WorkspaceLayout
  │   └── ui/              # Componentes base Shadcn (button, card, badge, input, etc.)
  ├── features/            # Módulos por jornada de negócio
  │   ├── brain/           # Base de conhecimento, métricas e busca
  │   ├── testplans/       # Geração de plano de testes e exportação CSV
  │   ├── connect/         # Grid de integrações
  │   ├── pipelines/       # Pipelines e automações
  │   └── settings/        # Configurações e status do sistema
  ├── lib/                 # Utilitários compartilhados
  │   ├── api-client.ts    # Cliente HTTP tipado para comunicação com o Backend
  │   └── utils.ts         # Helper cn() (clsx + tailwind-merge)
  ├── App.tsx              # Roteamento e orquestração de telas
  ├── main.tsx             # Ponto de entrada do React
  └── index.css            # Diretivas do Tailwind e tokens do Design System
```

---

## 📐 Diretrizes e Regras de Implementação

### 1. Comunicação com o Backend

- Nunca realize chamadas `fetch` soltas dentro de componentes de apresentação.
- Toda interação com a API deve passar pelo `ApiClient` em [`src/lib/api-client.ts`](./src/lib/api-client.ts).
- Trate sempre todos os estados da requisição: **Loading**, **Success**, **Empty** (ex: HTTP 204), **Error** (ex: HTTP 403/500) e **Retry**.

### 2. Estilização com Tailwind e Shadcn

- Use utilitários do Tailwind alinhados às variáveis de tema dark do design system:
  - Fundo principal: `bg-[var(--surface-0)]` ou tokens semânticos (`bg-background`).
  - Superfícies: `bg-[var(--surface-1)]`, `bg-[var(--surface-2)]`.
  - Bordas: `border-[var(--border)]` e `border-[var(--border-strong)]`.
  - Acentos: `text-[var(--text-accent)]`, `bg-[var(--fill-accent)]`.
- Componentes da pasta `components/ui/` devem seguir o padrão Shadcn com `cva` (Class Variance Authority) e `cn()`.

### 3. Acessibilidade e UX

- Todo elemento interativo deve possuir rótulos acessíveis (`aria-label`, `aria-current`, `aria-expanded`).
- Foco de teclado visível (`focus-visible:outline-none focus-visible:ring-2`).
- Feedback visual imediato durante operações assíncronas (skeletons ou animações de loading como dot-pulse).

### 4. Cobertura de Testes Obrigatória

- O gate `npm run verify` exige **100% de cobertura** em todos os arquivos de `src/` (exceto `main.tsx` e `*.d.ts`).
- Para cada novo componente ou feature criada, crie o teste correspondente em `tests/` cobrindo renderização, interações do usuário e estados de erro.

# Frontend Architecture & Design System Guidelines

Este documento estabelece as diretrizes arquiteturais e regras de design system para o desenvolvimento e evolução do `@adk/frontend`.

---

## 1. Reutilização Obrigatória de Componentes de UI

- **Proibição de Tags HTML Brutas**: É estritamente proibido instanciar tags `<input>`, `<select>` ou `<button>` diretamente dentro de telas, recursos (`features/`), views e modais quando houver componente correspondente no Design System.
- **Componentes Padronizados**:
  - Para entradas de texto/busca/dados: utilizar sempre `<Input />` de `src/components/ui/input.js`.
  - Para caixas de seleção/dropdowns: utilizar sempre `<Select />` de `src/components/ui/select.js`.
  - Para ações e controles clicáveis: utilizar sempre `<Button />` de `src/components/ui/button.js`.
  - Para áreas de texto longo: utilizar `<Textarea />` de `src/components/ui/textarea.js`.
  - Para rótulos de status: utilizar `<Badge />` de `src/components/ui/badge.js`.
  - Para estados de carregamento (placeholders / loaders): utilizar sempre `<Skeleton />`, `<SkeletonText />` ou `<SkeletonCard />` de `src/components/ui/skeleton.js`.

---

## 2. Padrão de Dimensões para Inputs, Dropdowns e Botões (48px)

- **Altura Padrão Universal de 48px**:
  - Todos os inputs de texto, pesquisa, formulários, dropdowns (`<Select />`) e botões (`<Button />`) principais do sistema devem possuir **48px de altura padrão** (`h-[48px]`).
  - O espaçamento interno (padding horizontal `px-4` ou `px-5`), tipografia (`text-base`) e alinhamento de ícones devem ser proporcionais a essa altura de 48px.
- **Campos com Ícones**:
  - Ao utilizar ícones em inputs (ex: busca com lupa ou campos com validação), utilize as propriedades `leftIcon` e `rightIcon` do componente `<Input />`, preservando a altura de 48px.

---

## 3. Variantes e Estilização com `cva`

- Todos os componentes base de UI devem implementar variantes visuais utilizando a biblioteca `class-variance-authority` (`cva`):
  - **`Input`**: variantes `default`, `error`, `filled`.
  - **`Select`**: variantes `default`, `error`, `filled`.
  - **`Button`**: variantes `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`, com tamanhos padronizados (`default`, `sm`, `lg`, `icon`) e suporte à propriedade `isLoading`.
