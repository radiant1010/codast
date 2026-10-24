"""Expose only navigation tools from the pinned Serena runtime."""

READ_TOOLS = ('get_symbols_overview', 'find_symbol', 'find_referencing_symbols')
PROTECTED_PATHS = ('.env', '.env.*', '.git/', '.harness/', '.codast-documents/')


def restricted_project_init(original):
    def initialize(self, *, project_config, **kwargs):
        # Project negations must not undo protected paths in the final LSP ignore spec.
        project_config.ignored_paths = [*project_config.ignored_paths, *PROTECTED_PATHS]
        original(self, project_config=project_config, **kwargs)

    return initialize


def navigation_factory(base):
    # Serena project settings can expand context.fixed_tools; filter at registration too.
    class NavigationFactory(base):
        def _create_serena_agent(self, config, **kwargs):
            config.trusted_project_path_patterns = []
            return super()._create_serena_agent(config, **kwargs)

        def _get_initial_instructions(self):
            return 'Use the available symbol tools to inspect this project. Follow the task rules and approval boundaries.'

        def _iter_tools(self):
            tools = [tool for tool in super()._iter_tools() if tool.get_name() in READ_TOOLS]
            if not set(READ_TOOLS[:3]).issubset(tool.get_name() for tool in tools):
                raise ValueError('CODAST requires the Serena tools interface and symbol navigation tools.')
            return iter(tools)

    return NavigationFactory


if __name__ == '__main__':
    import serena.mcp
    from serena.project import Project
    from serena.cli import top_level

    # This factory hook is verified against the exact commit installed by codast init.
    serena.mcp.SerenaMCPFactory = navigation_factory(serena.mcp.SerenaMCPFactory)
    Project.__init__ = restricted_project_init(Project.__init__)
    top_level()
