export function createProjectScope() {
  let projectRoot = null;
  let generation = 0;

  return {
    activate(nextProjectRoot) {
      projectRoot = nextProjectRoot;
      generation += 1;
      return { projectRoot, generation };
    },
    capture(expectedProjectRoot = projectRoot) {
      return { projectRoot: expectedProjectRoot, generation };
    },
    isCurrent(token) {
      return (
        token.generation === generation &&
        token.projectRoot === projectRoot
      );
    },
    current() {
      return { projectRoot, generation };
    },
  };
}