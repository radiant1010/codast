"""Start the local harness with the project's standard single-process settings."""
import uvicorn


if __name__ == '__main__':
    uvicorn.run('app.main:app', host='127.0.0.1', port=8765)
