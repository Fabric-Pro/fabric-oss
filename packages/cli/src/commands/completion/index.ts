/**
 * fabric completion
 *
 *   fabric completion bash    Output bash completion script
 *   fabric completion zsh     Output zsh completion script
 *   fabric completion fish    Output fish completion script
 */

import { Command } from "commander";

const BASH_COMPLETION = `
# fabric bash completion
_fabric_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="auth ctx orgs projects features workflows prompts agents skills mcp frames workspaces chats reports config completion"

  case "$prev" in
    fabric)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      return ;;
    auth)
      COMPREPLY=($(compgen -W "login logout whoami keys" -- "$cur"))
      return ;;
    keys)
      COMPREPLY=($(compgen -W "list create revoke" -- "$cur"))
      return ;;
    ctx)
      COMPREPLY=($(compgen -W "current use" -- "$cur"))
      return ;;
    orgs)
      COMPREPLY=($(compgen -W "list show" -- "$cur"))
      return ;;
    projects)
      COMPREPLY=($(compgen -W "list show create update" -- "$cur"))
      return ;;
    features)
      COMPREPLY=($(compgen -W "list show create update tasks" -- "$cur"))
      return ;;
    workflows)
      COMPREPLY=($(compgen -W "list show trigger status" -- "$cur"))
      return ;;
    prompts)
      COMPREPLY=($(compgen -W "list get create update" -- "$cur"))
      return ;;
    agents)
      COMPREPLY=($(compgen -W "list show execute" -- "$cur"))
      return ;;
    skills)
      COMPREPLY=($(compgen -W "list show" -- "$cur"))
      return ;;
    mcp)
      COMPREPLY=($(compgen -W "servers configs" -- "$cur"))
      return ;;
    configs)
      COMPREPLY=($(compgen -W "list show delete" -- "$cur"))
      return ;;
    frames)
      COMPREPLY=($(compgen -W "list show" -- "$cur"))
      return ;;
    workspaces)
      COMPREPLY=($(compgen -W "list show" -- "$cur"))
      return ;;
    chats)
      COMPREPLY=($(compgen -W "list show" -- "$cur"))
      return ;;
    reports)
      COMPREPLY=($(compgen -W "templates executions" -- "$cur"))
      return ;;
    templates)
      COMPREPLY=($(compgen -W "list show" -- "$cur"))
      return ;;
    executions)
      COMPREPLY=($(compgen -W "list" -- "$cur"))
      return ;;
    completion)
      COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur"))
      return ;;
  esac

  COMPREPLY=($(compgen -W "--format --org --personal --quiet --help" -- "$cur"))
}

complete -F _fabric_completion fabric
`.trim();

const ZSH_COMPLETION = `
#compdef fabric

_fabric() {
  local state

  _arguments \\
    '--format[Output format]:format:(table json yaml csv)' \\
    '--version[Show version]' \\
    '--help[Show help]' \\
    '1: :->command' \\
    '*: :->args'

  case $state in
    command)
      local commands=(
        'auth:Authenticate and manage API keys'
        'ctx:Manage active context'
        'orgs:List organizations'
        'projects:Manage projects'
        'features:Manage project features'
        'workflows:Manage workflows'
        'prompts:Manage prompts'
        'agents:Manage agents'
        'skills:Browse skills'
        'mcp:Manage MCP servers and configs'
        'frames:Manage AI-generated frames'
        'workspaces:Manage workspaces'
        'chats:View AI chat history'
        'reports:Manage reports'
        'config:Show CLI configuration'
        'completion:Output shell completion script'
      )
      _describe 'command' commands
      ;;
    args)
      case $words[2] in
        auth)
          local subcmds=('login:Log in' 'logout:Log out' 'whoami:Show current user' 'keys:Manage API keys')
          _describe 'subcommand' subcmds ;;
        projects)
          local subcmds=('list:List projects' 'show:Show project' 'create:Create project' 'update:Update project')
          _describe 'subcommand' subcmds ;;
        features)
          local subcmds=('list:List features' 'show:Show feature' 'create:Create feature' 'update:Update feature' 'tasks:List tasks')
          _describe 'subcommand' subcmds ;;
        workflows)
          local subcmds=('list:List workflows' 'show:Show workflow' 'trigger:Trigger workflow' 'status:Check status')
          _describe 'subcommand' subcmds ;;
        prompts)
          local subcmds=('list:List prompts' 'get:Get prompt' 'create:Create prompt' 'update:Update prompt')
          _describe 'subcommand' subcmds ;;
        agents)
          local subcmds=('list:List agents' 'show:Show agent' 'execute:Execute agent')
          _describe 'subcommand' subcmds ;;
        mcp)
          local subcmds=('servers:List MCP servers' 'configs:Manage MCP configs')
          _describe 'subcommand' subcmds ;;
        frames)
          local subcmds=('list:List frames' 'show:Show frame')
          _describe 'subcommand' subcmds ;;
        workspaces)
          local subcmds=('list:List workspaces' 'show:Show workspace')
          _describe 'subcommand' subcmds ;;
        skills)
          local subcmds=('list:List skills' 'show:Show skill')
          _describe 'subcommand' subcmds ;;
        chats)
          local subcmds=('list:List chats' 'show:Show chat')
          _describe 'subcommand' subcmds ;;
        reports)
          local subcmds=('templates:Manage report templates' 'executions:List report executions')
          _describe 'subcommand' subcmds ;;
        completion)
          local subcmds=('bash:Bash completion' 'zsh:Zsh completion' 'fish:Fish completion')
          _describe 'subcommand' subcmds ;;
      esac ;;
  esac
}

_fabric "$@"
`.trim();

const FISH_COMPLETION = `
# fabric fish completion
set -l fabric_commands auth ctx orgs projects features workflows prompts agents skills mcp frames workspaces chats reports config completion

complete -c fabric -f

# Top-level commands
complete -c fabric -n '__fish_use_subcommand' -a auth -d 'Authenticate and manage API keys'
complete -c fabric -n '__fish_use_subcommand' -a ctx -d 'Manage active context'
complete -c fabric -n '__fish_use_subcommand' -a orgs -d 'List organizations'
complete -c fabric -n '__fish_use_subcommand' -a projects -d 'Manage projects'
complete -c fabric -n '__fish_use_subcommand' -a features -d 'Manage project features'
complete -c fabric -n '__fish_use_subcommand' -a workflows -d 'Manage workflows'
complete -c fabric -n '__fish_use_subcommand' -a prompts -d 'Manage prompts'
complete -c fabric -n '__fish_use_subcommand' -a agents -d 'Manage agents'
complete -c fabric -n '__fish_use_subcommand' -a skills -d 'Browse skills'
complete -c fabric -n '__fish_use_subcommand' -a mcp -d 'Manage MCP servers and configs'
complete -c fabric -n '__fish_use_subcommand' -a frames -d 'Manage AI-generated frames'
complete -c fabric -n '__fish_use_subcommand' -a workspaces -d 'Manage workspaces'
complete -c fabric -n '__fish_use_subcommand' -a chats -d 'View AI chat history'
complete -c fabric -n '__fish_use_subcommand' -a reports -d 'Manage reports'
complete -c fabric -n '__fish_use_subcommand' -a config -d 'Show CLI configuration'
complete -c fabric -n '__fish_use_subcommand' -a completion -d 'Output shell completion script'

# Subcommands
complete -c fabric -n '__fish_seen_subcommand_from auth' -a 'login logout whoami keys'
complete -c fabric -n '__fish_seen_subcommand_from ctx' -a 'current use'
complete -c fabric -n '__fish_seen_subcommand_from orgs' -a 'list show'
complete -c fabric -n '__fish_seen_subcommand_from projects' -a 'list show create update'
complete -c fabric -n '__fish_seen_subcommand_from features' -a 'list show create update tasks'
complete -c fabric -n '__fish_seen_subcommand_from workflows' -a 'list show trigger status'
complete -c fabric -n '__fish_seen_subcommand_from prompts' -a 'list get create update'
complete -c fabric -n '__fish_seen_subcommand_from agents' -a 'list show execute'
complete -c fabric -n '__fish_seen_subcommand_from skills' -a 'list show'
complete -c fabric -n '__fish_seen_subcommand_from mcp' -a 'servers configs'
complete -c fabric -n '__fish_seen_subcommand_from configs' -a 'list show delete'
complete -c fabric -n '__fish_seen_subcommand_from frames' -a 'list show'
complete -c fabric -n '__fish_seen_subcommand_from workspaces' -a 'list show'
complete -c fabric -n '__fish_seen_subcommand_from chats' -a 'list show'
complete -c fabric -n '__fish_seen_subcommand_from reports' -a 'templates executions'
complete -c fabric -n '__fish_seen_subcommand_from templates' -a 'list show'
complete -c fabric -n '__fish_seen_subcommand_from executions' -a 'list'
complete -c fabric -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'

# Common flags
complete -c fabric -l format -d 'Output format' -a 'table json yaml csv'
complete -c fabric -l org -d 'Organization context' -r
complete -c fabric -l personal -d 'Personal context'
complete -c fabric -s q -l quiet -d 'Quiet output'
complete -c fabric -l help -d 'Show help'
`.trim();

export function buildCompletionCommand(): Command {
	const completion = new Command("completion").description(
		"Output shell completion script",
	);

	completion
		.command("bash")
		.description("Output bash completion script")
		.action(() => {
			process.stdout.write(`${BASH_COMPLETION}\n`);
			process.stderr.write(
				'# Add to ~/.bashrc:\n#   eval "$(fabric completion bash)"\n',
			);
		});

	completion
		.command("zsh")
		.description("Output zsh completion script")
		.action(() => {
			process.stdout.write(`${ZSH_COMPLETION}\n`);
			process.stderr.write(
				'# Add to ~/.zshrc:\n#   eval "$(fabric completion zsh)"\n',
			);
		});

	completion
		.command("fish")
		.description("Output fish completion script")
		.action(() => {
			process.stdout.write(`${FISH_COMPLETION}\n`);
			process.stderr.write(
				"# Save to ~/.config/fish/completions/fabric.fish\n",
			);
		});

	return completion;
}
