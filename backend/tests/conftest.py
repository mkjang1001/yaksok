import pytest

from app.db import init_sample_db
from app.search import DrugIndex


@pytest.fixture
def conn(tmp_path):
    c = init_sample_db(tmp_path / "test.db")
    yield c
    c.close()


@pytest.fixture
def index(conn):
    return DrugIndex(conn)
