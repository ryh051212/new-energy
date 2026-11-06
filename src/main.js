import { createApp } from 'vue'

// 恢复旧的样式导入，程序正常运行
import './styles/base.css'
import './styles/planner.css'
import './styles/planning.css'
import './styles/workspace.css'
import './styles/auth.css'

import App from './App.vue'

createApp(App).mount('#app')
