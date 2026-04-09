import anyio
from pathlib import Path
import yaml
from pydantic import BaseModel, Field
from apscheduler.triggers.cron import CronTrigger
from plombery import task, get_logger, Trigger, register_pipeline
from sync_worker import run_sync

@task
async def sync_layer(params: SyncParams):
    logger = get_logger()
    config_name = params.config_name
    config_path = Path(__file__).parent / "config" / f"{config_name}.yaml"
    
    if not config_path.exists():
        logger.error("Missing config file: %s", config_path)
        return {"status": "error"}

    with open(config_path, 'r') as f:
        config = yaml.safe_load(f)
    
    logger.info("🚀 Starting Forensic Sync: %s", config_name)

    count = await anyio.to_thread.run_sync(run_sync, config, logger)
    
    return {"status": "success", "rows": count}

LAYERS = ["active_leaks", "drinking_water_pipes", "waste_water_pipes", "storm_water_pipes"]

for layer in LAYERS:

    class SyncParams(BaseModel):
        config_name: str = layer

    register_pipeline(
        id=f"sync_{layer}",
        name=f"Sync {layer.replace('_', ' ').title()}",
        description=f"Automated forensic sync for {layer}",
        tasks=[sync_layer],
        params=SyncParams,
        triggers=[
            Trigger(
                id=f"daily_{layer}",
                name="Daily Sync",
                description=f"Scheduled 2AM sync for {layer}",
                params=SyncParams(config_name=layer),
                schedule=CronTrigger.from_crontab("0 2 * * *"),
            ),
        ],
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("plombery:get_app", reload=True, factory=True, port=8000)