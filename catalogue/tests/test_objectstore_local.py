"""LocalObjectStore (the folder that stands in for a bucket) and the parts of objectstore.py that need no Google library."""
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from factories import object_store_contract
from terucon_catalogue import objectstore
from terucon_catalogue.objectstore import (InvalidKeyError, LocalObjectStore, ObjectNotFoundError, StoreConfigError, normalise_store_prefix,
                                           object_store_from_env, validate_key)


def test_contract(tmp_path):
    object_store_contract(LocalObjectStore(tmp_path / "bucket"), tmp_path)


def test_contract_with_a_prefix(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket", prefix="catalogue/")
    object_store_contract(store, tmp_path)
    assert not any(p.suffix == ".part" for p in (tmp_path / "bucket").rglob("*"))


def test_the_prefix_is_added_by_the_store_and_never_shows_in_keys(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket", prefix="/catalogue")
    assert store.prefix == "catalogue/"
    store.put_bytes("crops/a.png", b"x")
    assert (tmp_path / "bucket" / "catalogue" / "crops" / "a.png").read_bytes() == b"x"
    assert store.list("") == ["crops/a.png"]


def test_if_absent_is_atomic_under_a_race(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket")
    results = []
    barrier = threading.Barrier(8)

    def writer(index):
        barrier.wait()
        results.append(store.put_bytes("crops/x.png", f"writer-{index}".encode() * 1000, if_absent=True))

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count(True) == 1 and results.count(False) == 7
    content = store.get_bytes("crops/x.png")
    assert content in {f"writer-{i}".encode() * 1000 for i in range(8)}        # one whole writer's bytes, never a mixture


def test_temp_files_are_never_listed_and_failed_copies_leave_nothing(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket")
    store.put_bytes("a/b.bin", b"x")
    (tmp_path / "bucket" / "a" / ".part-leftover").write_bytes(b"half")
    assert store.list("a/") == ["a/b.bin"]
    with pytest.raises(FileNotFoundError):
        store.put_file("a/c.bin", tmp_path / "no-such-file")
    assert store.list("a/") == ["a/b.bin"]


def test_a_symlink_cannot_lead_outside_the_store(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    store = LocalObjectStore(tmp_path / "bucket")
    os.symlink(outside, tmp_path / "bucket" / "link")
    with pytest.raises(InvalidKeyError):
        store.get_bytes("link/secret.txt")
    with pytest.raises(InvalidKeyError):
        store.put_bytes("link/new.txt", b"x")
    assert not (outside / "new.txt").exists()


def test_a_name_that_is_also_a_folder_is_explained_not_crashed(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket")
    store.put_bytes("a/b", b"x")
    with pytest.raises(objectstore.ObjectStoreError, match="already an object"):
        store.put_bytes("a/b/c", b"y")
    store.put_bytes("d/e/f", b"z")
    with pytest.raises(objectstore.ObjectStoreError, match="other objects live below"):
        store.put_bytes("d/e", b"y")


def test_delete_tidies_up_empty_folders_but_keeps_the_root(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket", prefix="p")
    store.put_bytes("a/b/c.bin", b"x")
    store.delete("a/b/c.bin")
    assert not (tmp_path / "bucket" / "p" / "a").exists()
    assert (tmp_path / "bucket").is_dir()


def test_put_bytes_takes_bytes_only(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket")
    with pytest.raises(TypeError):
        store.put_bytes("a.txt", "text, not bytes")
    assert store.put_bytes("a.bin", bytearray(b"ok")) and store.get_bytes("a.bin") == b"ok"


def test_signed_url_of_a_local_store_is_a_file_url(tmp_path):
    store = LocalObjectStore(tmp_path / "bucket")
    store.put_bytes("crops/a.png", b"x")
    url = store.signed_get_url("crops/a.png")
    assert url.startswith("file:///") and url.endswith("/crops/a.png")


@pytest.mark.parametrize("key", ["crops/c/a.png", "a", "releases/cat/rel-20261101120000-abcdef/pillars/dino.ids.json", "sources/" + "a" * 64 + "/x y.pdf", "é/日本.png"])
def test_good_keys(key):
    assert validate_key(key) == key


@pytest.mark.parametrize("key", ["", "/a", "a//b", "a/", "a/../b", "..", ".", "a/./b", "a\\b", "a\x00", "a\x1f", "a\x7f", "a\u0085b", "a b", "x" * 1025, None, 5])
def test_bad_keys(key):
    with pytest.raises(InvalidKeyError):
        validate_key(key)


def test_normalise_store_prefix():
    assert normalise_store_prefix(None) == "" and normalise_store_prefix("") == "" and normalise_store_prefix("/") == ""
    assert normalise_store_prefix("catalogue") == "catalogue/" == normalise_store_prefix("/catalogue/")
    with pytest.raises(InvalidKeyError):
        normalise_store_prefix("a/../b")


def test_object_store_from_env_local(tmp_path):
    store = object_store_from_env({"CATALOGUE_LOCAL_STORE": str(tmp_path / "s"), "CATALOGUE_GCS_BUCKET": "ignored"})
    assert isinstance(store, LocalObjectStore) and store.prefix == ""
    store = object_store_from_env({"CATALOGUE_LOCAL_STORE": str(tmp_path / "s"), "CATALOGUE_GCS_PREFIX": "catalogue/"})
    assert store.prefix == "catalogue/"


def test_object_store_from_env_explains_what_is_missing():
    with pytest.raises(StoreConfigError, match="CATALOGUE_GCS_BUCKET"):
        object_store_from_env({})
    with pytest.raises(StoreConfigError) as caught:
        object_store_from_env({"CATALOGUE_GCS_BUCKET": "my-bucket"})
    assert "my-bucket" in str(caught.value) and "service account" in str(caught.value)


def test_object_store_from_env_never_echoes_the_key(tmp_path):
    secret = "VERY-SECRET-KEY-MATERIAL"
    with pytest.raises(StoreConfigError) as caught:
        object_store_from_env({"CATALOGUE_GCS_BUCKET": "b", "GCP_SERVICE_ACCOUNT_JSON": '{"type": "service_account", "private_key": "%s"}' % secret})
    assert secret not in str(caught.value)


def test_importing_objectstore_imports_no_google_library_and_no_network():
    code = ("import sys; import terucon_catalogue.objectstore as o; "
            "bad = [m for m in sys.modules if m.startswith(('google', 'pymongo', 'torch', 'requests'))]; print('BAD', bad)")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=Path(__file__).resolve().parent.parent)
    assert result.returncode == 0, result.stderr
    assert "BAD []" in result.stdout, result.stdout


def test_object_not_found_is_a_file_not_found_and_a_key_error():
    error = ObjectNotFoundError("no object 'x'")
    assert isinstance(error, FileNotFoundError) and isinstance(error, KeyError) and str(error) == "no object 'x'"
