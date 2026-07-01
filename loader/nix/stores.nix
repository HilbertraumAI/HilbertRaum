# The dist/.stores reader now lives in the shared loader nix lib; this thin
# wrapper passes the project's dist/.stores dir. (Records are written by the
# loader's store-import.sh; see third_party/loader/nix/loader/stores.nix.)
# Requires --impure (storePath + reading dist/.stores outside the flake).
import ../third_party/loader/nix/loader/stores.nix { distStores = ../dist/.stores; }
