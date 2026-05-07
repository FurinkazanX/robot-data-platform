from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


class BaseConverter(ABC):
    """Abstract base for all dataset converters."""

    name: str = ""
    source_format: str = ""
    target_format: str = ""

    @abstractmethod
    def preview(self, src_path: Path) -> Dict[str, Any]:
        """Return metadata / field tree of the source file."""

    @abstractmethod
    def convert(
        self,
        src_path: Path,
        dst_path: Path,
        field_mapping: Dict[str, str],
        incremental: bool = False,
        progress_cb: Optional[Callable[[int, int, str], None]] = None,
    ) -> None:
        """Convert src_path to dst_path using field_mapping."""


# Registry
_REGISTRY: Dict[str, type[BaseConverter]] = {}


def register_converter(cls: type[BaseConverter]) -> type[BaseConverter]:
    _REGISTRY[f"{cls.source_format}->{cls.target_format}"] = cls
    return cls


def get_converter(source_format: str, target_format: str) -> BaseConverter:
    key = f"{source_format}->{target_format}"
    if key not in _REGISTRY:
        raise ValueError(f"No converter registered for {key}")
    return _REGISTRY[key]()


def list_converters() -> List[Dict[str, str]]:
    return [
        {"key": k, "source": v.source_format, "target": v.target_format, "name": v.name}
        for k, v in _REGISTRY.items()
    ]
