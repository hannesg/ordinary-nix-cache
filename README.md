# ordinary-nix-cache

## Usage

In your github actions, after installing nix, add the ordinary-nix-cache action like this:

```
jobs:
  build:
    steps:
      - uses: DeterminateSystems/nix-installer-action@main
      - uses: hannesg/ordinary-nix-cache@v0.1.0  # <---- here
      - run: nix build ".#devShell.x86_64-linux"
```

This does three things:

1. It starts a small http server that translates the nix remote cache protocol to the github actions cache protocol.
2. It sets up this http server as additional nix cache.
3. It sets up a `post-build` action that automatically uploads all nix builds to the github actions cache.

## Configuration

None 😎

## Unistall

Just remove the action from your github actions config.

To purge all caches, you can use `gh`:

```
gh cache list --json id -k "nix0" | jq '.[] | .id' | xargs -l gh cache delete
```

You have to run this a few times because `gh` gives you only 100 entries per run.

## Development

Use nix + direnv to install dependencies dev dependencies.

Use `bun` to install js dependencies:

```bash
bun install
```

Run tests using `bun`

```bash
bun test
```

Bundle using `bun`

```
bun build --minify --target node index.js > dist/index.mjs
```
