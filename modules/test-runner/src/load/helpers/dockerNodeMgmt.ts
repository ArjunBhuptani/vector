import {spawn, exec} from 'child_process'
import {
    messaging_config,
    pull_router_image_opts,
    test_docker_compose_configuration,
} from "./dockerNodeConfig";
const swarm_init_str = 'docker swarm init 2> /dev/null || true'
const d_net_create_str = 'docker network create --attachable --driver overlay "$project" 2> /dev/null || true'

const start_router = 'bash ops/start-router.sh'

export const swarm_init = ()=> exec(
                          swarm_init_str,
    ((e,r)=>(console.log(e,r))))

export const d_net_create = ()=>  exec(
                            d_net_create_str,
    ((e,r)=>console.log(e,r))
)


export const d_start_router = ()=>  exec(
    start_router,
    ((e,r)=>console.log(e,r))
)

//Start with script
// export const spawn_router_start = spawn('bash',["ops/start-router.sh"], {shell:true})

export const echo_router_config = spawn(`bash`, ['-c',`echo "${test_docker_compose_configuration}" > router.config.test.yml`])

export const spawn_router_start = spawn('docker',["stack", "deploy", "-c", "router.config.test.yml", "router"], {shell:true})

//Pull images
// export const pull_router_image = spawn('bash', pull_router_image_opts);
// const spawn_router_start = spawn('bash', pull_router_image_opts);


export const  spawn_n_routers = (num_routers) => {
    // spawn('bash',["ops/start-router.sh"], {shell:true})
    spawn('docker',["stack", "deploy", "-c", "router.config.test.yml", "router"], {shell:true})

    for (let i = 0; i < num_routers; i++) {
        spawn_router_start.stdout.on('data', (data) => {
            console.log("Data from router node " + data)
        })
        spawn_router_start.stderr.on('data', (data) => {
            console.log("stderr: " + data)
        })
        spawn_router_start.stdout.on('close', (code) => {
            if (code)
                console.log("process finished, exit code " + code)
        })
    }
}

interface Command {
    cmd:string,
    args:string[]
}

class ProcessHandler{
    success_str: string;
    success:boolean|undefined = undefined;

    constructor(_success_str:string) {
        this.success_str = _success_str;
    }

    cmp_stdout(stdout:string){
        const res_str = String(stdout);
        console.log(res_str);
        const res = res_str.includes(this.success_str);
        if(!res){
            console.log("process handler not finding a result that makes sense")
            return this.success=false;
        }
        console.log("Success")
        return this.success=true;
    }

    cb_stdout_data(data:string){
        this.cmp_stdout(data)
    }
    cb_stdout_close(data:string){
        console.log("process closed")
        return 0;
    }

}

class SpawnProcess {
    returnCode:number|undefined = undefined;
    command:Command;
    handler:ProcessHandler;
    process;

    constructor(_command:Command, _handler:ProcessHandler){
        this.command = _command;
        this.handler = _handler;

    }

    register_events(){
                this.process.stderr.on('data', (event_data) => {
                    console.log("STDERR: " + event_data)
                })

                this.process.stdout.on('data', (event_data) => {
                    console.log("STDOUT: " + event_data)
                    this.handler.cb_stdout_data(event_data)
                })
                this.process.stdout.on('close', (event_data) => {
                    console.log("PROCESS CLOSE: " + event_data)
                    this.returnCode = this.handler.cb_stdout_close(event_data)
                })
    }

    exec(){
        this.process = spawn(this.command.cmd, this.command.args, {shell:true})
        this.register_events()
    }

    async getResult():Promise<boolean|undefined>{
        const delay = (ms)=>{
            return new Promise<void>((resolve)=>
                setTimeout(function(){
                    console.log("waiting for process to resolve");
                    resolve();
                },ms))

        }
        while(this.handler.success === undefined){
            await delay(20);

        }
       return this.handler.success;
    }

}


// export const echo_router_config_cmd = spawn(`bash`, ['-c', `echo "${test_docker_compose_configuration}" > router.config.test.yml`])
// export const echo_messaging_config_cmd = spawn(`bash`, ['-c',`echo "${messaging_config}" > messaging.config.test.yml`])

const messagingStart: Command = {cmd:'docker', args:["stack", "deploy", "-c", "messaging.config.test.yml", "messaging"]};
const messaging_handler:ProcessHandler = new ProcessHandler("");
export const start_messaging:SpawnProcess = new SpawnProcess(messagingStart, messaging_handler);

const routerStart: Command = {cmd:'docker', args:["stack", "deploy", "-c", "simnet_compose.yml", "router"]};
const test_handler:ProcessHandler = new ProcessHandler("");
export const test_process:SpawnProcess = new SpawnProcess(routerStart, test_handler);


